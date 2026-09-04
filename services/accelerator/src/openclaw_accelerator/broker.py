#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import re
import secrets
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


DEFAULT_SOCKET_PATH = Path("/run/openclaw-accelerator/accelerator.sock")
MAX_CONFIG_BYTES = 65_536
MAX_REQUEST_BYTES = 16_384
MAX_RESPONSE_BYTES = 65_536
REQUEST_TIMEOUT_SEC = 5.0
MAX_REQUESTS_PER_MINUTE = 120
MAX_LEASES_PER_UID = 32
NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC = 10.0
PCI_ENUMERATION_STABLE_SEC = 0.5
DEGRADED_RESET_TIMEOUT_SEC = 5.0
PROTOCOL_VERSION = 1

_ID_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_BDF_RE = re.compile(r"^0000:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$")
_HEX_ID_RE = re.compile(r"^0x[0-9a-f]{4}$")
_UNIT_RE = re.compile(r"^[a-zA-Z0-9_.@-]+\.service$")

_SYSTEMCTL = "/usr/bin/systemctl"
_MODPROBE = "/usr/sbin/modprobe"
_NVIDIA_SMI = "/usr/bin/nvidia-smi"
_PYTHON3 = "/usr/bin/python3"
_CUDA_DRIVER_PROBE = "/usr/lib/openclaw-accelerator/cuda_driver_probe.py"
_NVIDIA_READINESS_QUERY = (
    _NVIDIA_SMI,
    "--query-gpu=persistence_mode",
    "--format=csv,noheader,nounits",
)
_CUDA_DRIVER_READINESS_QUERY = (
    _PYTHON3,
    _CUDA_DRIVER_PROBE,
)
_COMMAND_ENV = {"LANG": "C", "LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}


class AcceleratorError(RuntimeError):
    code = "accelerator_error"
    retryable = False


class AcceleratorConfigError(AcceleratorError):
    code = "accelerator_config_invalid"


class AcceleratorBusyError(AcceleratorError):
    code = "accelerator_busy"
    retryable = True


class AcceleratorUnavailableError(AcceleratorError):
    code = "accelerator_unavailable"
    retryable = True

    def __init__(self, message: str, *, stage: str = "") -> None:
        super().__init__(message)
        self.stage = str(stage or "")


class LeaseNotFoundError(AcceleratorError):
    code = "accelerator_lease_not_found"


class LeaseOwnershipError(AcceleratorError):
    code = "accelerator_lease_owner_mismatch"


@dataclass(frozen=True)
class AcceleratorConfig:
    accelerator_id: str
    backend: str
    root_port_bdf: str
    root_port_vendor_id: str
    root_port_device_id: str
    branch_bdf: str
    branch_vendor_id: str
    branch_device_id: str
    downstream_bridge_bdf: str
    downstream_bridge_vendor_id: str
    downstream_bridge_device_id: str
    gpu_bdf: str
    audio_bdf: str
    gpu_vendor_id: str
    gpu_device_id: str
    audio_device_id: str
    persistence_service: str
    idle_timeout_sec: float
    startup_guard_sec: float
    attach_timeout_sec: float
    nvidia_readiness_timeout_sec: float
    default_lease_ttl_sec: float
    max_lease_ttl_sec: float
    automatic_power_management: bool

    @classmethod
    def from_dict(cls, accelerator_id: str, raw: dict[str, Any]) -> "AcceleratorConfig":
        if not _ID_RE.fullmatch(accelerator_id):
            raise AcceleratorConfigError("accelerator id is invalid")
        if not isinstance(raw, dict):
            raise AcceleratorConfigError("accelerator profile must be an object")
        allowed = {
            "backend",
            "root_port_bdf",
            "root_port_vendor_id",
            "root_port_device_id",
            "branch_bdf",
            "branch_vendor_id",
            "branch_device_id",
            "downstream_bridge_bdf",
            "downstream_bridge_vendor_id",
            "downstream_bridge_device_id",
            "gpu_bdf",
            "audio_bdf",
            "gpu_vendor_id",
            "gpu_device_id",
            "audio_device_id",
            "persistence_service",
            "idle_timeout_sec",
            "startup_guard_sec",
            "attach_timeout_sec",
            "nvidia_readiness_timeout_sec",
            "default_lease_ttl_sec",
            "max_lease_ttl_sec",
            "automatic_power_management",
        }
        if set(raw) != allowed:
            raise AcceleratorConfigError("accelerator profile fields are incomplete or unknown")
        if raw.get("backend") != "linux_pci_nvidia":
            raise AcceleratorConfigError("accelerator backend is unsupported")
        for field in (
            "root_port_bdf",
            "branch_bdf",
            "downstream_bridge_bdf",
            "gpu_bdf",
            "audio_bdf",
        ):
            if not _BDF_RE.fullmatch(str(raw.get(field) or "")):
                raise AcceleratorConfigError(f"{field} is invalid")
        bdfs = {
            str(raw["root_port_bdf"]),
            str(raw["branch_bdf"]),
            str(raw["downstream_bridge_bdf"]),
            str(raw["gpu_bdf"]),
            str(raw["audio_bdf"]),
        }
        if len(bdfs) != 5:
            raise AcceleratorConfigError("accelerator BDFs must be unique")
        for field in (
            "root_port_vendor_id",
            "root_port_device_id",
            "branch_vendor_id",
            "branch_device_id",
            "downstream_bridge_vendor_id",
            "downstream_bridge_device_id",
            "gpu_vendor_id",
            "gpu_device_id",
            "audio_device_id",
        ):
            if not _HEX_ID_RE.fullmatch(str(raw.get(field) or "")):
                raise AcceleratorConfigError(f"{field} is invalid")
        service = str(raw.get("persistence_service") or "")
        if not _UNIT_RE.fullmatch(service):
            raise AcceleratorConfigError("persistence service is invalid")
        if not isinstance(raw.get("automatic_power_management"), bool):
            raise AcceleratorConfigError("automatic_power_management must be boolean")

        def bounded_float(field: str, minimum: float, maximum: float) -> float:
            if isinstance(raw[field], bool) or not isinstance(raw[field], (int, float)):
                raise AcceleratorConfigError(f"{field} must be numeric")
            value = float(raw[field])
            if not math.isfinite(value) or value < minimum or value > maximum:
                raise AcceleratorConfigError(f"{field} is outside its allowed range")
            return value

        default_ttl = bounded_float("default_lease_ttl_sec", 5.0, 86_400.0)
        max_ttl = bounded_float("max_lease_ttl_sec", default_ttl, 86_400.0)
        return cls(
            accelerator_id=accelerator_id,
            backend="linux_pci_nvidia",
            root_port_bdf=str(raw["root_port_bdf"]),
            root_port_vendor_id=str(raw["root_port_vendor_id"]),
            root_port_device_id=str(raw["root_port_device_id"]),
            branch_bdf=str(raw["branch_bdf"]),
            branch_vendor_id=str(raw["branch_vendor_id"]),
            branch_device_id=str(raw["branch_device_id"]),
            downstream_bridge_bdf=str(raw["downstream_bridge_bdf"]),
            downstream_bridge_vendor_id=str(raw["downstream_bridge_vendor_id"]),
            downstream_bridge_device_id=str(raw["downstream_bridge_device_id"]),
            gpu_bdf=str(raw["gpu_bdf"]),
            audio_bdf=str(raw["audio_bdf"]),
            gpu_vendor_id=str(raw["gpu_vendor_id"]),
            gpu_device_id=str(raw["gpu_device_id"]),
            audio_device_id=str(raw["audio_device_id"]),
            persistence_service=service,
            idle_timeout_sec=bounded_float("idle_timeout_sec", 10.0, 86_400.0),
            startup_guard_sec=bounded_float("startup_guard_sec", 10.0, 3_600.0),
            attach_timeout_sec=bounded_float("attach_timeout_sec", 5.0, 300.0),
            nvidia_readiness_timeout_sec=bounded_float(
                "nvidia_readiness_timeout_sec",
                5.0,
                600.0,
            ),
            default_lease_ttl_sec=default_ttl,
            max_lease_ttl_sec=max_ttl,
            automatic_power_management=bool(raw["automatic_power_management"]),
        )


@dataclass(frozen=True)
class BrokerConfig:
    accelerators: dict[str, AcceleratorConfig]

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "BrokerConfig":
        if not isinstance(raw, dict) or set(raw) != {"version", "accelerators"}:
            raise AcceleratorConfigError("broker config fields are invalid")
        if raw.get("version") != PROTOCOL_VERSION or isinstance(
            raw.get("version"), bool
        ):
            raise AcceleratorConfigError("broker config version is unsupported")
        profiles = raw.get("accelerators")
        if not isinstance(profiles, dict) or not profiles or len(profiles) > 8:
            raise AcceleratorConfigError("accelerator profile count is invalid")
        return cls({
            str(accelerator_id): AcceleratorConfig.from_dict(str(accelerator_id), profile)
            for accelerator_id, profile in profiles.items()
        })

    @classmethod
    def from_path(cls, path: Path) -> "BrokerConfig":
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise AcceleratorConfigError("broker config is not a regular file")
            if metadata.st_uid != 0 or metadata.st_mode & 0o022:
                raise AcceleratorConfigError("broker config ownership or mode is unsafe")
            if metadata.st_size <= 0 or metadata.st_size > MAX_CONFIG_BYTES:
                raise AcceleratorConfigError("broker config size is invalid")
            with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
                descriptor = -1
                payload = json.load(stream)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        return cls.from_dict(payload)


@dataclass(frozen=True)
class HardwareProbe:
    branch_present: bool
    gpu_present: bool
    audio_present: bool
    gpu_driver: str
    audio_driver: str
    client_names: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return (
            self.branch_present
            and self.gpu_present
            and self.audio_present
            and self.gpu_driver == "nvidia"
            and self.audio_driver == "snd_hda_intel"
        )

    @property
    def off(self) -> bool:
        return not self.branch_present and not self.gpu_present and not self.audio_present

    def public_payload(self) -> dict[str, Any]:
        return {
            "branch_present": self.branch_present,
            "gpu_present": self.gpu_present,
            "audio_present": self.audio_present,
            "gpu_driver_ready": self.gpu_driver == "nvidia",
            "audio_driver_ready": self.audio_driver == "snd_hda_intel",
            "client_count": len(self.client_names),
            "client_names": list(self.client_names),
            "process_ids_included": False,
            "arguments_included": False,
        }


class AcceleratorBackend(Protocol):
    def probe(self) -> HardwareProbe: ...
    def ensure_ready(self) -> HardwareProbe: ...
    def power_off(self) -> HardwareProbe: ...


class LinuxPciNvidiaBackend:
    def __init__(self, config: AcceleratorConfig) -> None:
        self.config = config
        self._degraded_reset_attempt_count = 0
        self._degraded_reset_success_count = 0

    @staticmethod
    def _pci_node(bdf: str) -> Path:
        return Path("/sys/bus/pci/devices") / bdf

    @staticmethod
    def _driver(node: Path) -> str:
        driver = node / "driver"
        if not driver.is_symlink():
            return ""
        try:
            return driver.resolve(strict=True).name
        except OSError:
            return ""

    @staticmethod
    def _run(
        argv: list[str],
        *,
        timeout: float = 30.0,
        check: bool = True,
        failure_stage: str = "fixed_command",
    ) -> subprocess.CompletedProcess[str]:
        try:
            completed = subprocess.run(
                argv,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=_COMMAND_ENV,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AcceleratorUnavailableError(
                f"fixed accelerator command could not run: {Path(argv[0]).name}",
                stage=failure_stage,
            ) from exc
        if check and completed.returncode != 0:
            raise AcceleratorUnavailableError(
                f"fixed accelerator command failed: {Path(argv[0]).name}",
                stage=failure_stage,
            )
        return completed

    @staticmethod
    def _write(path: Path, value: str) -> None:
        descriptor = os.open(path, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.write(descriptor, value.encode("ascii"))
        finally:
            os.close(descriptor)

    @staticmethod
    def _client_names() -> tuple[str, ...]:
        names: set[str] = set()
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            try:
                descriptors = list((proc / "fd").iterdir())
            except (FileNotFoundError, PermissionError):
                continue
            matched = False
            for descriptor in descriptors:
                try:
                    target = os.readlink(descriptor)
                except (FileNotFoundError, PermissionError, OSError):
                    continue
                if target.startswith("/dev/nvidia"):
                    matched = True
                    break
            if not matched:
                continue
            try:
                name = (proc / "comm").read_text(encoding="utf-8", errors="replace").strip()
            except (FileNotFoundError, PermissionError):
                name = "unknown"
            names.add((name or "unknown")[:64])
            if len(names) >= 64:
                break
        return tuple(sorted(names))

    @staticmethod
    def _validate_identity(node: Path, *, vendor_id: str, device_id: str) -> None:
        try:
            vendor = (node / "vendor").read_text(encoding="ascii").strip().lower()
            device = (node / "device").read_text(encoding="ascii").strip().lower()
        except OSError as exc:
            raise AcceleratorUnavailableError("accelerator identity is unavailable") from exc
        if vendor != vendor_id or device != device_id:
            raise AcceleratorUnavailableError("accelerator identity mismatch")

    def _validate_topology(self) -> None:
        root_port = self._pci_node(self.config.root_port_bdf)
        branch = self._pci_node(self.config.branch_bdf)
        downstream = self._pci_node(self.config.downstream_bridge_bdf)
        gpu = self._pci_node(self.config.gpu_bdf)
        audio = self._pci_node(self.config.audio_bdf)
        for node in (root_port, branch, downstream, gpu, audio):
            if not node.is_dir():
                raise AcceleratorUnavailableError("accelerator topology is incomplete")
        self._validate_identity(
            root_port,
            vendor_id=self.config.root_port_vendor_id,
            device_id=self.config.root_port_device_id,
        )
        self._validate_identity(
            branch,
            vendor_id=self.config.branch_vendor_id,
            device_id=self.config.branch_device_id,
        )
        self._validate_identity(
            downstream,
            vendor_id=self.config.downstream_bridge_vendor_id,
            device_id=self.config.downstream_bridge_device_id,
        )
        self._validate_identity(
            gpu,
            vendor_id=self.config.gpu_vendor_id,
            device_id=self.config.gpu_device_id,
        )
        self._validate_identity(
            audio,
            vendor_id=self.config.gpu_vendor_id,
            device_id=self.config.audio_device_id,
        )
        try:
            root_path = root_port.resolve(strict=True)
            branch_path = branch.resolve(strict=True)
        except OSError as exc:
            raise AcceleratorUnavailableError("accelerator topology cannot be resolved") from exc
        if not branch_path.is_relative_to(root_path):
            raise AcceleratorUnavailableError("accelerator branch is outside its root port")
        expected = {
            self.config.branch_bdf,
            self.config.downstream_bridge_bdf,
            self.config.gpu_bdf,
            self.config.audio_bdf,
        }
        actual = {branch_path.name}
        for path in branch_path.rglob("*"):
            if path.is_dir() and _BDF_RE.fullmatch(path.name):
                actual.add(path.name)
        if actual != expected:
            raise AcceleratorUnavailableError("accelerator branch inventory mismatch")
        if any(branch_path.rglob("net/*")) or any(branch_path.rglob("block/*")):
            raise AcceleratorUnavailableError("accelerator branch contains protected devices")

    def probe(self) -> HardwareProbe:
        branch = self._pci_node(self.config.branch_bdf)
        gpu = self._pci_node(self.config.gpu_bdf)
        audio = self._pci_node(self.config.audio_bdf)
        return HardwareProbe(
            branch_present=branch.is_dir(),
            gpu_present=gpu.is_dir(),
            audio_present=audio.is_dir(),
            gpu_driver=self._driver(gpu),
            audio_driver=self._driver(audio),
            client_names=self._client_names(),
        )

    def _wait_for_devices(self, root_port: Path, deadline: float) -> None:
        gpu = self._pci_node(self.config.gpu_bdf)
        audio = self._pci_node(self.config.audio_bdf)
        rescan = root_port / "rescan"
        next_rescan = 0.0
        stable_since: float | None = None
        last_topology_error: Exception | None = None
        while time.monotonic() < deadline:
            if gpu.is_dir() and audio.is_dir():
                try:
                    self._validate_topology()
                except (AcceleratorUnavailableError, OSError) as exc:
                    last_topology_error = exc
                    stable_since = None
                else:
                    now = time.monotonic()
                    if stable_since is None:
                        stable_since = now
                    elif now - stable_since >= PCI_ENUMERATION_STABLE_SEC:
                        return
                    time.sleep(0.1)
                    continue
            else:
                stable_since = None
            now = time.monotonic()
            if now >= next_rescan:
                if not rescan.exists():
                    raise AcceleratorUnavailableError(
                        "accelerator root-port rescan is unavailable",
                        stage="pci_rescan",
                    )
                try:
                    self._write(rescan, "1\n")
                except OSError as exc:
                    raise AcceleratorUnavailableError(
                        "accelerator root-port rescan failed",
                        stage="pci_rescan",
                    ) from exc
                next_rescan = now + 1.0
            time.sleep(0.25)
        raise AcceleratorUnavailableError(
            "accelerator PCI topology did not become ready",
            stage="pci_enumeration",
        ) from last_topology_error

    def _reset_stranded_topology_if_needed(self, probe: HardwareProbe) -> bool:
        stranded = (
            probe.branch_present
            and probe.gpu_present
            and probe.audio_present
            and probe.gpu_driver != "nvidia"
            and probe.audio_driver == "snd_hda_intel"
        )
        if not stranded:
            return False
        blocking_clients = tuple(
            name for name in probe.client_names if name != "nvidia-persiste"
        )
        if blocking_clients:
            raise AcceleratorBusyError(
                "degraded accelerator still has non-persistence clients"
            )
        self._degraded_reset_attempt_count += 1
        try:
            self._validate_topology()
            self._run(
                [_SYSTEMCTL, "stop", self.config.persistence_service],
                failure_stage="degraded_topology_reset",
            )
            time.sleep(0.25)
            if self._client_names():
                raise AcceleratorBusyError(
                    "degraded accelerator still has open device clients"
                )
            audio = self._pci_node(self.config.audio_bdf)
            if self._driver(audio) == "snd_hda_intel":
                self._write(
                    Path("/sys/bus/pci/drivers/snd_hda_intel/unbind"),
                    self.config.audio_bdf + "\n",
                )
            for module in ("nvidia_uvm", "nvidia_drm", "nvidia_modeset", "nvidia"):
                self._run(
                    [_MODPROBE, "-r", module],
                    check=False,
                    failure_stage="degraded_topology_reset",
                )
            branch = self._pci_node(self.config.branch_bdf)
            remove = branch / "remove"
            if not remove.exists():
                raise AcceleratorUnavailableError(
                    "degraded accelerator branch remove interface is unavailable",
                    stage="degraded_topology_reset",
                )
            self._write(remove, "1\n")
            deadline = time.monotonic() + min(
                DEGRADED_RESET_TIMEOUT_SEC,
                self.config.attach_timeout_sec,
            )
            while time.monotonic() < deadline:
                if self.probe().off:
                    self._degraded_reset_success_count += 1
                    return True
                time.sleep(0.1)
            raise AcceleratorUnavailableError(
                "degraded accelerator branch remained present after reset",
                stage="degraded_topology_reset",
            )
        except (AcceleratorBusyError, AcceleratorUnavailableError):
            raise
        except Exception as exc:
            raise AcceleratorUnavailableError(
                "degraded accelerator topology reset failed",
                stage="degraded_topology_reset",
            ) from exc

    def recovery_status(self) -> dict[str, int]:
        return {
            "degraded_reset_attempt_count": self._degraded_reset_attempt_count,
            "degraded_reset_success_count": self._degraded_reset_success_count,
        }

    def _bind_if_needed(
        self,
        bdf: str,
        driver_name: str,
        *,
        deadline: float,
    ) -> None:
        node = self._pci_node(bdf)
        bind = Path("/sys/bus/pci/drivers") / driver_name / "bind"
        if not bind.exists():
            raise AcceleratorUnavailableError(
                "accelerator driver bind interface is unavailable",
                stage="driver_bind",
            )
        last_error: OSError | None = None
        while time.monotonic() < deadline:
            if self._driver(node) == driver_name:
                return
            try:
                self._write(bind, bdf + "\n")
            except OSError as exc:
                last_error = exc
            time.sleep(0.1)
        if self._driver(node) == driver_name:
            return
        raise AcceleratorUnavailableError(
            "accelerator driver did not bind",
            stage="driver_bind",
        ) from last_error

    def ensure_ready(self) -> HardwareProbe:
        root_port = self._pci_node(self.config.root_port_bdf)
        if not root_port.is_dir():
            raise AcceleratorUnavailableError(
                "accelerator root port is unavailable",
                stage="root_port_validation",
            )
        self._validate_identity(
            root_port,
            vendor_id=self.config.root_port_vendor_id,
            device_id=self.config.root_port_device_id,
        )
        self._reset_stranded_topology_if_needed(self.probe())
        enumeration_deadline = time.monotonic() + self.config.attach_timeout_sec
        self._wait_for_devices(root_port, enumeration_deadline)

        # Cold Thunderbolt enumeration and NVIDIA userspace initialization are
        # independent bounded phases.  Reusing the enumeration deadline here
        # can leave no time for module binding or nvidia-smi after a slow wake.
        driver_deadline = time.monotonic() + self.config.attach_timeout_sec
        for module in ("nvidia", "nvidia_modeset", "nvidia_drm", "nvidia_uvm", "snd_hda_intel"):
            self._run(
                [_MODPROBE, module],
                timeout=max(1.0, driver_deadline - time.monotonic()),
                failure_stage="driver_module_load",
            )
        self._bind_if_needed(
            self.config.gpu_bdf,
            "nvidia",
            deadline=driver_deadline,
        )
        self._bind_if_needed(
            self.config.audio_bdf,
            "snd_hda_intel",
            deadline=driver_deadline,
        )
        self._run(
            [_SYSTEMCTL, "start", self.config.persistence_service],
            timeout=self.config.attach_timeout_sec,
            failure_stage="persistence_start",
        )

        readiness_deadline = (
            time.monotonic() + self.config.nvidia_readiness_timeout_sec
        )
        last_readiness_error: AcceleratorUnavailableError | None = None
        last_readiness_stage = "nvidia_readiness"
        readiness_succeeded = False
        while time.monotonic() < readiness_deadline:
            remaining = readiness_deadline - time.monotonic()
            try:
                self._run(
                    list(_NVIDIA_READINESS_QUERY),
                    timeout=max(
                        1.0,
                        min(NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC, remaining),
                    ),
                    failure_stage="nvidia_readiness",
                )
            except AcceleratorUnavailableError as exc:
                last_readiness_error = exc
                last_readiness_stage = "nvidia_readiness"
                time.sleep(0.25)
                continue
            remaining = readiness_deadline - time.monotonic()
            if remaining <= 0.0:
                break
            try:
                self._run(
                    list(_CUDA_DRIVER_READINESS_QUERY),
                    timeout=max(
                        1.0,
                        min(NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC, remaining),
                    ),
                    failure_stage="cuda_driver_readiness",
                )
            except AcceleratorUnavailableError as exc:
                last_readiness_error = exc
                last_readiness_stage = "cuda_driver_readiness"
                time.sleep(0.25)
                continue
            readiness_succeeded = True
            break
        if not readiness_succeeded:
            raise AcceleratorUnavailableError(
                "accelerator compute interface did not become ready",
                stage=last_readiness_stage,
            ) from last_readiness_error
        probe = self.probe()
        if not probe.ready:
            raise AcceleratorUnavailableError(
                "accelerator failed its readiness contract",
                stage="readiness_validation",
            )
        return probe

    def power_off(self) -> HardwareProbe:
        probe = self.probe()
        blocking_clients = tuple(name for name in probe.client_names if name != "nvidia-persiste")
        if blocking_clients:
            raise AcceleratorBusyError("accelerator still has non-persistence clients")
        self._validate_topology()
        try:
            self._run([_SYSTEMCTL, "stop", self.config.persistence_service])
            time.sleep(0.25)
            if self._client_names():
                raise AcceleratorBusyError("accelerator still has open device clients")
            audio = self._pci_node(self.config.audio_bdf)
            if self._driver(audio) == "snd_hda_intel":
                self._write(
                    Path("/sys/bus/pci/drivers/snd_hda_intel/unbind"),
                    self.config.audio_bdf + "\n",
                )
            for module in ("nvidia_uvm", "nvidia_drm", "nvidia_modeset", "nvidia"):
                self._run([_MODPROBE, "-r", module])
            branch = self._pci_node(self.config.branch_bdf)
            remove = branch / "remove"
            if not remove.exists():
                raise AcceleratorUnavailableError("accelerator branch remove interface is unavailable")
            self._write(remove, "1\n")
            probe = self.probe()
            if not probe.off:
                raise AcceleratorUnavailableError("accelerator branch remained present after removal")
            return probe
        except Exception:
            try:
                self.ensure_ready()
            except Exception:
                pass
            raise


@dataclass
class Lease:
    token: str
    owner_uid: int
    consumer: str
    expires_monotonic: float
    expires_epoch: float


class AcceleratorManager:
    def __init__(
        self,
        config: AcceleratorConfig,
        backend: AcceleratorBackend,
        *,
        start_monitor: bool = True,
        monotonic=time.monotonic,
        epoch=time.time,
    ) -> None:
        self.config = config
        self.backend = backend
        self._monotonic = monotonic
        self._epoch = epoch
        self._lock = threading.RLock()
        self._leases: dict[str, Lease] = {}
        self._started_at = monotonic()
        self._idle_since = self._started_at
        self._state = "unknown"
        self._last_error = ""
        self._last_error_stage = ""
        self._readiness_verified = False
        self._stop_event = threading.Event()
        self._monitor: threading.Thread | None = None
        self._reconcile_locked()
        if start_monitor:
            self._monitor = threading.Thread(target=self._monitor_loop, daemon=True)
            self._monitor.start()

    def close(self) -> None:
        self._stop_event.set()
        if self._monitor is not None:
            self._monitor.join(
                timeout=max(
                    self.config.attach_timeout_sec,
                    self.config.nvidia_readiness_timeout_sec,
                )
                + 120.0
            )

    def _reconcile_locked(self) -> HardwareProbe:
        probe = self.backend.probe()
        if probe.ready:
            self._state = "ready"
            # Structural PCI/driver readiness from a previous broker process
            # does not prove that the CUDA Driver API can initialize now. A
            # first acquire must re-run the bounded compute readiness contract.
            self._readiness_verified = False
        elif probe.off:
            self._state = "off"
            self._readiness_verified = False
        else:
            self._state = "degraded"
            self._readiness_verified = False
        return probe

    def _reap_locked(self, now: float) -> None:
        expired = [token for token, lease in self._leases.items() if lease.expires_monotonic <= now]
        for token in expired:
            self._leases.pop(token, None)
        if expired and not self._leases:
            self._idle_since = now

    def acquire(self, *, owner_uid: int, consumer: str, ttl_sec: float | None) -> dict[str, Any]:
        if not _ID_RE.fullmatch(consumer):
            raise AcceleratorConfigError("consumer id is invalid")
        if ttl_sec is not None and (
            isinstance(ttl_sec, bool) or not isinstance(ttl_sec, (int, float))
        ):
            raise AcceleratorConfigError("lease ttl must be numeric")
        ttl = self.config.default_lease_ttl_sec if ttl_sec is None else float(ttl_sec)
        if not math.isfinite(ttl) or ttl < 5.0 or ttl > self.config.max_lease_ttl_sec:
            raise AcceleratorConfigError("lease ttl is outside its allowed range")
        with self._lock:
            now = self._monotonic()
            self._reap_locked(now)
            if sum(1 for lease in self._leases.values() if lease.owner_uid == owner_uid) >= MAX_LEASES_PER_UID:
                raise AcceleratorBusyError("lease limit reached")
            probe = self.backend.probe()
            if not probe.ready or not self._readiness_verified:
                self._state = "attaching"
                try:
                    probe = self.backend.ensure_ready()
                except Exception as exc:
                    self._state = "fault"
                    self._readiness_verified = False
                    self._last_error = type(exc).__name__
                    self._last_error_stage = str(getattr(exc, "stage", "") or "")
                    raise
            self._state = "ready"
            self._readiness_verified = True
            self._last_error = ""
            self._last_error_stage = ""
            token = secrets.token_urlsafe(32)
            expires_epoch = self._epoch() + ttl
            self._leases[token] = Lease(token, owner_uid, consumer, now + ttl, expires_epoch)
            return {
                "lease_id": token,
                "accelerator_id": self.config.accelerator_id,
                "consumer": consumer,
                "expires_at_epoch": expires_epoch,
                "state": self._state,
                "hardware": probe.public_payload(),
            }

    def renew(self, *, owner_uid: int, token: str, ttl_sec: float | None) -> dict[str, Any]:
        if ttl_sec is not None and (
            isinstance(ttl_sec, bool) or not isinstance(ttl_sec, (int, float))
        ):
            raise AcceleratorConfigError("lease ttl must be numeric")
        ttl = self.config.default_lease_ttl_sec if ttl_sec is None else float(ttl_sec)
        if not math.isfinite(ttl) or ttl < 5.0 or ttl > self.config.max_lease_ttl_sec:
            raise AcceleratorConfigError("lease ttl is outside its allowed range")
        with self._lock:
            now = self._monotonic()
            self._reap_locked(now)
            lease = self._leases.get(token)
            if lease is None:
                raise LeaseNotFoundError("lease was not found")
            if lease.owner_uid != owner_uid:
                raise LeaseOwnershipError("lease belongs to another peer")
            lease.expires_monotonic = now + ttl
            lease.expires_epoch = self._epoch() + ttl
            return {"lease_id": token, "expires_at_epoch": lease.expires_epoch, "state": self._state}

    def release(self, *, owner_uid: int, token: str) -> dict[str, Any]:
        with self._lock:
            lease = self._leases.get(token)
            if lease is None:
                raise LeaseNotFoundError("lease was not found")
            if lease.owner_uid != owner_uid:
                raise LeaseOwnershipError("lease belongs to another peer")
            self._leases.pop(token, None)
            if not self._leases:
                self._idle_since = self._monotonic()
            return {"released": True, "state": self._state}

    def status(self) -> dict[str, Any]:
        with self._lock:
            now = self._monotonic()
            self._reap_locked(now)
            probe = self.backend.probe()
            if probe.ready and self._readiness_verified:
                self._state = "ready"
            elif probe.ready and self._last_error:
                self._state = "fault"
            elif probe.ready:
                self._state = "degraded"
            elif probe.off:
                self._state = "off"
                self._readiness_verified = False
            else:
                self._state = "degraded"
                self._readiness_verified = False
            consumers: dict[str, int] = defaultdict(int)
            for lease in self._leases.values():
                consumers[lease.consumer] += 1
            return {
                "accelerator_id": self.config.accelerator_id,
                "state": self._state,
                "automatic_power_management": self.config.automatic_power_management,
                "lease_count": len(self._leases),
                "consumer_counts": dict(sorted(consumers.items())),
                "idle_for_sec": max(0.0, now - self._idle_since) if not self._leases else 0.0,
                "startup_guard_remaining_sec": max(
                    0.0,
                    self.config.startup_guard_sec - (now - self._started_at),
                ),
                "last_error_type": self._last_error,
                "last_error_stage": self._last_error_stage,
                "readiness_verified": self._readiness_verified,
                "hardware": probe.public_payload(),
                "recovery": (
                    self.backend.recovery_status()
                    if hasattr(self.backend, "recovery_status")
                    else {
                        "degraded_reset_attempt_count": 0,
                        "degraded_reset_success_count": 0,
                    }
                ),
                "lease_ids_included": False,
            }

    def tick(self) -> bool:
        with self._lock:
            now = self._monotonic()
            self._reap_locked(now)
            if not self.config.automatic_power_management or self._leases:
                return False
            if now - self._started_at < self.config.startup_guard_sec:
                return False
            if now - self._idle_since < self.config.idle_timeout_sec:
                return False
            probe = self.backend.probe()
            if probe.off:
                self._state = "off"
                self._readiness_verified = False
                return False
            if not probe.ready:
                self._state = "degraded"
                self._readiness_verified = False
                return False
            self._state = "detaching"
            try:
                self.backend.power_off()
            except AcceleratorBusyError as exc:
                self._state = "ready"
                self._last_error = type(exc).__name__
                self._last_error_stage = str(getattr(exc, "stage", "") or "")
                self._idle_since = now
                return False
            except Exception as exc:
                self._readiness_verified = False
                self._state = "fault"
                self._last_error = type(exc).__name__
                self._last_error_stage = str(getattr(exc, "stage", "") or "")
                self._idle_since = now
                return False
            self._state = "off"
            self._readiness_verified = False
            self._last_error = ""
            self._last_error_stage = ""
            return True

    def _monitor_loop(self) -> None:
        while not self._stop_event.wait(1.0):
            self.tick()


class BrokerRuntime:
    def __init__(self, config: BrokerConfig, *, start_monitor: bool = True) -> None:
        self.managers = {
            accelerator_id: AcceleratorManager(
                profile,
                LinuxPciNvidiaBackend(profile),
                start_monitor=start_monitor,
            )
            for accelerator_id, profile in config.accelerators.items()
        }
        self._request_times: dict[int, deque[float]] = defaultdict(deque)
        self._rate_lock = threading.Lock()

    def close(self) -> None:
        for manager in self.managers.values():
            manager.close()

    def _admit(self, uid: int) -> None:
        now = time.monotonic()
        with self._rate_lock:
            queue = self._request_times[uid]
            while queue and queue[0] <= now - 60.0:
                queue.popleft()
            if len(queue) >= MAX_REQUESTS_PER_MINUTE:
                raise AcceleratorBusyError("accelerator request rate exceeded")
            queue.append(now)

    def _manager(self, request: dict[str, Any]) -> AcceleratorManager:
        accelerator_id = str(request.get("accelerator_id") or "")
        manager = self.managers.get(accelerator_id)
        if manager is None:
            raise AcceleratorConfigError("accelerator id is unknown")
        return manager

    @staticmethod
    def _fields(request: dict[str, Any], allowed: set[str]) -> None:
        if set(request) - allowed:
            raise AcceleratorConfigError("request contains unsupported fields")

    def dispatch(self, request: dict[str, Any], *, peer_uid: int) -> dict[str, Any]:
        self._admit(peer_uid)
        if request.get("version") != PROTOCOL_VERSION or isinstance(
            request.get("version"), bool
        ):
            raise AcceleratorConfigError("protocol version is unsupported")
        action = str(request.get("action") or "")
        if action == "status":
            self._fields(request, {"version", "action", "accelerator_id"})
            payload = self._manager(request).status()
        elif action == "acquire":
            self._fields(request, {"version", "action", "accelerator_id", "consumer", "ttl_sec"})
            payload = self._manager(request).acquire(
                owner_uid=peer_uid,
                consumer=str(request.get("consumer") or ""),
                ttl_sec=request.get("ttl_sec"),
            )
        elif action == "renew":
            self._fields(request, {"version", "action", "accelerator_id", "lease_id", "ttl_sec"})
            payload = self._manager(request).renew(
                owner_uid=peer_uid,
                token=str(request.get("lease_id") or ""),
                ttl_sec=request.get("ttl_sec"),
            )
        elif action == "release":
            self._fields(request, {"version", "action", "accelerator_id", "lease_id"})
            payload = self._manager(request).release(
                owner_uid=peer_uid,
                token=str(request.get("lease_id") or ""),
            )
        else:
            raise AcceleratorConfigError("accelerator action is unsupported")
        return {"ok": True, "version": PROTOCOL_VERSION, **payload}


def _peer_uid(connection: socket.socket) -> int:
    if not hasattr(socket, "SO_PEERCRED"):
        raise PermissionError("peer credentials are unavailable")
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    _pid, uid, _gid = struct.unpack("3i", credentials)
    return int(uid)


class AcceleratorHandler(socketserver.StreamRequestHandler):
    def setup(self) -> None:
        self.request.settimeout(REQUEST_TIMEOUT_SEC)
        super().setup()

    def handle(self) -> None:
        try:
            raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
            if not raw or len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
                raise AcceleratorConfigError("request framing is invalid")
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise AcceleratorConfigError("request must be an object")
            response = self.server.runtime.dispatch(  # type: ignore[attr-defined]
                request,
                peer_uid=_peer_uid(self.request),
            )
        except Exception as exc:
            response = {
                "ok": False,
                "version": PROTOCOL_VERSION,
                "error_code": getattr(exc, "code", "accelerator_internal_error"),
                "error_type": type(exc).__name__,
                "error_stage": str(getattr(exc, "stage", "") or ""),
                "retryable": bool(getattr(exc, "retryable", False)),
            }
        encoded = json.dumps(response, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
        if len(encoded) > MAX_RESPONSE_BYTES:
            encoded = b'{"ok":false,"version":1,"error_code":"accelerator_response_too_large"}\n'
        self.wfile.write(encoded)


class AcceleratorServer(socketserver.ThreadingMixIn, socketserver.BaseServer):
    daemon_threads = True

    def __init__(self, activated_socket: socket.socket, runtime: BrokerRuntime) -> None:
        self.runtime = runtime
        super().__init__(str(DEFAULT_SOCKET_PATH), AcceleratorHandler)
        self.socket = activated_socket

    def fileno(self) -> int:
        return self.socket.fileno()

    def get_request(self) -> tuple[socket.socket, Any]:
        return self.socket.accept()

    def server_close(self) -> None:
        self.runtime.close()
        self.socket.close()

    @staticmethod
    def close_request(request: socket.socket) -> None:
        request.close()


def _systemd_socket() -> socket.socket:
    if int(os.environ.get("LISTEN_PID", "0")) != os.getpid():
        raise RuntimeError("accelerator broker requires systemd socket activation")
    if int(os.environ.get("LISTEN_FDS", "0")) != 1:
        raise RuntimeError("accelerator broker requires exactly one activated socket")
    names = str(os.environ.get("LISTEN_FDNAMES") or "")
    if names and names != "accelerator":
        raise RuntimeError("accelerator broker received an unexpected socket")
    return socket.socket(fileno=3)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bounded OpenClaw accelerator lifecycle broker")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    runtime = BrokerRuntime(BrokerConfig.from_path(args.config))
    server = AcceleratorServer(_systemd_socket(), runtime)

    def request_shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    with server:
        server.serve_forever(poll_interval=0.5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
