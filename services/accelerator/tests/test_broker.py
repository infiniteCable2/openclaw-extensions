from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
BROKER_PATH = SERVICE_ROOT / "src" / "openclaw_accelerator" / "broker.py"
CLIENT_PATH = SERVICE_ROOT / "src" / "openclaw_accelerator" / "client.py"
CUDA_PROBE_PATH = SERVICE_ROOT / "src" / "openclaw_accelerator" / "cuda_driver_probe.py"


def _broker_module():
    name = "openclaw_accelerator_broker"
    spec = importlib.util.spec_from_file_location(name, BROKER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _client_module():
    name = "openclaw_accelerator_client"
    spec = importlib.util.spec_from_file_location(name, CLIENT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _cuda_probe_module():
    name = "openclaw_accelerator_cuda_driver_probe"
    spec = importlib.util.spec_from_file_location(name, CUDA_PROBE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_cuda_driver_probe_requires_successful_initialization_and_a_device() -> None:
    probe = _cuda_probe_module()

    class Driver:
        pass

    driver = Driver()

    def cu_init(_flags):
        return 0

    def cu_device_get_count(pointer):
        probe.ctypes.cast(
            pointer,
            probe.ctypes.POINTER(probe.ctypes.c_int),
        ).contents.value = 1
        return 0

    driver.cuInit = cu_init
    driver.cuDeviceGetCount = cu_device_get_count
    assert probe.probe_cuda_driver(lambda _name: driver) == 1

    cu_init_result = 802

    def unavailable_init(_flags):
        return cu_init_result

    driver.cuInit = unavailable_init
    with pytest.raises(probe.CudaDriverProbeError, match="initialization"):
        probe.probe_cuda_driver(lambda _name: driver)


def _profile(*, automatic: bool = False) -> dict:
    return {
        "backend": "linux_pci_nvidia",
        "root_port_bdf": "0000:00:07.1",
        "root_port_vendor_id": "0x8086",
        "root_port_device_id": "0x9a25",
        "branch_bdf": "0000:2d:00.0",
        "branch_vendor_id": "0x8086",
        "branch_device_id": "0x15da",
        "downstream_bridge_bdf": "0000:2e:01.0",
        "downstream_bridge_vendor_id": "0x8086",
        "downstream_bridge_device_id": "0x15da",
        "gpu_bdf": "0000:2f:00.0",
        "audio_bdf": "0000:2f:00.1",
        "gpu_vendor_id": "0x10de",
        "gpu_device_id": "0x2783",
        "audio_device_id": "0x22bc",
        "persistence_service": "nvidia-persistenced.service",
        "idle_timeout_sec": 10,
        "startup_guard_sec": 10,
        "attach_timeout_sec": 30,
        "nvidia_readiness_timeout_sec": 60,
        "default_lease_ttl_sec": 30,
        "max_lease_ttl_sec": 300,
        "automatic_power_management": automatic,
    }


class _Clock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class _Backend:
    def __init__(self, broker, *, ready: bool = True, clients: tuple[str, ...] = ()) -> None:
        self.broker = broker
        self.ready = ready
        self.clients = clients
        self.ensure_count = 0
        self.off_count = 0

    def probe(self):
        if self.ready:
            return self.broker.HardwareProbe(True, True, True, "nvidia", "snd_hda_intel", self.clients)
        return self.broker.HardwareProbe(False, False, False, "", "", ())

    def ensure_ready(self):
        self.ensure_count += 1
        self.ready = True
        return self.probe()

    def power_off(self):
        if self.clients:
            raise self.broker.AcceleratorBusyError("busy")
        self.off_count += 1
        self.ready = False
        return self.probe()


def test_accelerator_config_rejects_unknown_fields_and_arbitrary_backend() -> None:
    broker = _broker_module()
    profile = _profile()
    profile["command"] = "rm -rf /"
    with pytest.raises(broker.AcceleratorConfigError, match="fields"):
        broker.AcceleratorConfig.from_dict("primary_cuda", profile)

    profile = _profile()
    profile["backend"] = "shell"
    with pytest.raises(broker.AcceleratorConfigError, match="unsupported"):
        broker.AcceleratorConfig.from_dict("primary_cuda", profile)

    profile = _profile()
    profile["automatic_power_management"] = "false"
    with pytest.raises(broker.AcceleratorConfigError, match="must be boolean"):
        broker.AcceleratorConfig.from_dict("primary_cuda", profile)


def test_accelerator_config_and_leases_reject_non_finite_numbers() -> None:
    broker = _broker_module()
    profile = _profile()
    profile["idle_timeout_sec"] = float("nan")
    with pytest.raises(broker.AcceleratorConfigError, match="allowed range"):
        broker.AcceleratorConfig.from_dict("primary_cuda", profile)

    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    manager = broker.AcceleratorManager(
        config,
        _Backend(broker),
        start_monitor=False,
    )
    with pytest.raises(broker.AcceleratorConfigError, match="allowed range"):
        manager.acquire(owner_uid=1000, consumer="stt", ttl_sec=float("nan"))


def test_accelerator_handler_bounds_incomplete_connections() -> None:
    broker = _broker_module()
    client_socket, server_socket = broker.socket.socketpair()
    handler = object.__new__(broker.AcceleratorHandler)
    handler.request = server_socket
    try:
        handler.setup()
        assert server_socket.gettimeout() == broker.REQUEST_TIMEOUT_SEC
    finally:
        if hasattr(handler, "rfile"):
            handler.finish()
        client_socket.close()
        server_socket.close()


def test_acquire_restores_hardware_and_lease_is_owner_bound() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    clock = _Clock()
    backend = _Backend(broker, ready=False)
    manager = broker.AcceleratorManager(
        config,
        backend,
        start_monitor=False,
        monotonic=clock,
        epoch=clock,
    )

    acquired = manager.acquire(owner_uid=1000, consumer="stt", ttl_sec=60)
    assert backend.ensure_count == 1
    assert acquired["state"] == "ready"
    assert acquired["lease_id"]

    with pytest.raises(broker.LeaseOwnershipError):
        manager.release(owner_uid=1001, token=acquired["lease_id"])

    released = manager.release(owner_uid=1000, token=acquired["lease_id"])
    assert released["released"] is True
    assert manager.status()["lease_count"] == 0


def test_first_acquire_reverifies_ready_hardware_after_broker_start() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = _Backend(broker, ready=True)
    manager = broker.AcceleratorManager(config, backend, start_monitor=False)

    initial = manager.status()
    assert initial["state"] == "degraded"
    assert initial["readiness_verified"] is False

    manager.acquire(owner_uid=1000, consumer="tts", ttl_sec=60)

    assert backend.ensure_count == 1
    assert manager.status()["readiness_verified"] is True


def test_repeated_root_port_rescan_covers_delayed_cold_enumeration(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    clock = _Clock()

    root_port = tmp_path / "root-port"
    gpu = tmp_path / "gpu"
    audio = tmp_path / "audio"
    root_port.mkdir()
    (root_port / "rescan").write_text("", encoding="ascii")

    nodes = {
        config.root_port_bdf: root_port,
        config.gpu_bdf: gpu,
        config.audio_bdf: audio,
    }
    monkeypatch.setattr(backend, "_pci_node", lambda bdf: nodes[bdf])
    monkeypatch.setattr(backend, "_validate_topology", lambda: None)
    monkeypatch.setattr(broker.time, "monotonic", clock)
    monkeypatch.setattr(broker.time, "sleep", clock.advance)

    rescans = []

    def delayed_rescan(_path, _value):
        rescans.append(True)
        if len(rescans) == 2:
            gpu.mkdir()
            audio.mkdir()

    monkeypatch.setattr(backend, "_write", delayed_rescan)

    backend._wait_for_devices(root_port, clock() + 5.0)
    assert len(rescans) == 2


def test_degraded_audio_bound_topology_is_removed_before_reenumeration(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    clock = _Clock()
    nodes = {}
    for bdf in (
        config.root_port_bdf,
        config.branch_bdf,
        config.downstream_bridge_bdf,
        config.gpu_bdf,
        config.audio_bdf,
    ):
        node = tmp_path / bdf.replace(":", "_")
        node.mkdir()
        nodes[bdf] = node
    (nodes[config.branch_bdf] / "remove").write_text("", encoding="ascii")
    removed = False
    writes = []
    commands = []

    monkeypatch.setattr(backend, "_pci_node", lambda bdf: nodes[bdf])
    monkeypatch.setattr(backend, "_validate_topology", lambda: None)
    monkeypatch.setattr(backend, "_client_names", lambda: ())
    monkeypatch.setattr(
        backend,
        "_driver",
        lambda node: "snd_hda_intel" if node == nodes[config.audio_bdf] else "",
    )
    monkeypatch.setattr(broker.time, "monotonic", clock)
    monkeypatch.setattr(broker.time, "sleep", clock.advance)

    def record_write(path, value):
        nonlocal removed
        writes.append((path, value))
        if path == nodes[config.branch_bdf] / "remove":
            removed = True

    def record_command(argv, *, timeout=30.0, check=True, failure_stage="fixed_command"):
        commands.append((tuple(argv), timeout, check, failure_stage))
        return broker.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(backend, "_write", record_write)
    monkeypatch.setattr(backend, "_run", record_command)
    monkeypatch.setattr(
        backend,
        "probe",
        lambda: (
            broker.HardwareProbe(False, False, False, "", "", ())
            if removed
            else broker.HardwareProbe(
                True, True, True, "", "snd_hda_intel", ()
            )
        ),
    )

    degraded = backend.probe()
    assert backend._reset_stranded_topology_if_needed(degraded) is True
    assert backend.recovery_status() == {
        "degraded_reset_attempt_count": 1,
        "degraded_reset_success_count": 1,
    }
    assert any(path.name == "unbind" for path, _value in writes)
    assert any(path.name == "remove" for path, _value in writes)
    unloads = [item for item in commands if item[0][1:2] == ("-r",)]
    assert len(unloads) == 4
    assert all(item[2] is False for item in unloads)
    assert all(item[3] == "degraded_topology_reset" for item in unloads)


def test_degraded_topology_reset_fails_closed_with_device_clients(
    monkeypatch,
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    writes = []
    monkeypatch.setattr(backend, "_write", lambda *args: writes.append(args))

    degraded = broker.HardwareProbe(
        True,
        True,
        True,
        "",
        "snd_hda_intel",
        ("embedding-worker",),
    )
    with pytest.raises(broker.AcceleratorBusyError, match="clients"):
        backend._reset_stranded_topology_if_needed(degraded)

    assert writes == []
    assert backend.recovery_status() == {
        "degraded_reset_attempt_count": 0,
        "degraded_reset_success_count": 0,
    }


def test_unclassified_degraded_topology_is_not_mutated(monkeypatch) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    writes = []
    monkeypatch.setattr(backend, "_write", lambda *args: writes.append(args))

    degraded = broker.HardwareProbe(True, True, False, "", "", ())
    assert backend._reset_stranded_topology_if_needed(degraded) is False
    assert writes == []
    assert backend.recovery_status() == {
        "degraded_reset_attempt_count": 0,
        "degraded_reset_success_count": 0,
    }


def test_ensure_ready_resets_stranded_topology_before_enumeration(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    root_port = tmp_path / "root-port"
    root_port.mkdir()
    events = []
    probes = iter(
        (
            broker.HardwareProbe(True, True, True, "", "snd_hda_intel", ()),
            broker.HardwareProbe(
                True, True, True, "nvidia", "snd_hda_intel", ()
            ),
        )
    )

    monkeypatch.setattr(backend, "_pci_node", lambda _bdf: root_port)
    monkeypatch.setattr(backend, "_validate_identity", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        backend,
        "_reset_stranded_topology_if_needed",
        lambda probe: events.append(("reset", probe.gpu_driver)) or True,
    )
    monkeypatch.setattr(
        backend,
        "_wait_for_devices",
        lambda *_args, **_kwargs: events.append(("enumerate", "")),
    )
    monkeypatch.setattr(backend, "_bind_if_needed", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backend, "probe", lambda: next(probes))
    monkeypatch.setattr(
        backend,
        "_run",
        lambda argv, **_kwargs: broker.subprocess.CompletedProcess(
            argv, 0, "", ""
        ),
    )

    assert backend.ensure_ready().ready is True
    assert events[:2] == [("reset", ""), ("enumerate", "")]


def test_nvidia_readiness_gets_fresh_deadline_after_cold_enumeration(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    clock = _Clock()
    root_port = tmp_path / "root-port"
    root_port.mkdir()

    monkeypatch.setattr(backend, "_pci_node", lambda _bdf: root_port)
    monkeypatch.setattr(backend, "_validate_identity", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(broker.time, "monotonic", clock)
    monkeypatch.setattr(broker.time, "sleep", clock.advance)

    def slow_enumeration(_root_port, _deadline):
        clock.advance(config.attach_timeout_sec - 0.5)

    monkeypatch.setattr(backend, "_wait_for_devices", slow_enumeration)
    monkeypatch.setattr(backend, "_bind_if_needed", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        backend,
        "probe",
        lambda: broker.HardwareProbe(
            True,
            True,
            True,
            "nvidia",
            "snd_hda_intel",
            (),
        ),
    )

    readiness_timeouts = []
    cuda_probe_timeouts = []

    def record_command(argv, *, timeout=30.0, check=True, failure_stage="fixed_command"):
        del check
        if argv[0] == broker._NVIDIA_SMI:
            assert tuple(argv) == broker._NVIDIA_READINESS_QUERY
            readiness_timeouts.append(timeout)
            assert failure_stage == "nvidia_readiness"
        elif tuple(argv) == broker._CUDA_DRIVER_READINESS_QUERY:
            cuda_probe_timeouts.append(timeout)
            assert failure_stage == "cuda_driver_readiness"
        return broker.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(backend, "_run", record_command)

    assert backend.ensure_ready().ready is True
    assert len(readiness_timeouts) == 1
    assert readiness_timeouts[0] == pytest.approx(
        broker.NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC
    )
    assert len(cuda_probe_timeouts) == 1
    assert cuda_probe_timeouts[0] == pytest.approx(
        broker.NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC
    )


def test_nvidia_readiness_retries_hung_management_probes_within_phase_budget(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    clock = _Clock()
    root_port = tmp_path / "root-port"
    root_port.mkdir()

    monkeypatch.setattr(backend, "_pci_node", lambda _bdf: root_port)
    monkeypatch.setattr(backend, "_validate_identity", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backend, "_wait_for_devices", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backend, "_bind_if_needed", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(broker.time, "monotonic", clock)
    monkeypatch.setattr(broker.time, "sleep", clock.advance)
    monkeypatch.setattr(
        backend,
        "probe",
        lambda: broker.HardwareProbe(
            True,
            True,
            True,
            "nvidia",
            "snd_hda_intel",
            (),
        ),
    )

    readiness_timeouts = []
    cuda_probe_count = 0

    def delayed_management(argv, *, timeout=30.0, check=True, failure_stage="fixed_command"):
        nonlocal cuda_probe_count
        del check
        if argv[0] == broker._NVIDIA_SMI:
            assert tuple(argv) == broker._NVIDIA_READINESS_QUERY
            readiness_timeouts.append(timeout)
            clock.advance(timeout)
            if len(readiness_timeouts) < 3:
                raise broker.AcceleratorUnavailableError(
                    "management probe timed out",
                    stage=failure_stage,
                )
        elif tuple(argv) == broker._CUDA_DRIVER_READINESS_QUERY:
            cuda_probe_count += 1
        return broker.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(backend, "_run", delayed_management)

    assert backend.ensure_ready().ready is True
    assert readiness_timeouts == [
        broker.NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC,
        broker.NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC,
        broker.NVIDIA_READINESS_ATTEMPT_TIMEOUT_SEC,
    ]
    assert clock.value < 1_000.0 + config.nvidia_readiness_timeout_sec
    assert cuda_probe_count == 1


def test_cuda_driver_readiness_retries_within_same_phase_budget(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)
    clock = _Clock()
    root_port = tmp_path / "root-port"
    root_port.mkdir()

    monkeypatch.setattr(backend, "_pci_node", lambda _bdf: root_port)
    monkeypatch.setattr(backend, "_validate_identity", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backend, "_wait_for_devices", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backend, "_bind_if_needed", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(broker.time, "monotonic", clock)
    monkeypatch.setattr(broker.time, "sleep", clock.advance)
    monkeypatch.setattr(
        backend,
        "probe",
        lambda: broker.HardwareProbe(
            True, True, True, "nvidia", "snd_hda_intel", (),
        ),
    )

    management_attempts = 0
    cuda_attempts = 0

    def delayed_cuda(argv, *, timeout=30.0, check=True, failure_stage="fixed_command"):
        nonlocal management_attempts, cuda_attempts
        del check, timeout
        if argv[0] == broker._NVIDIA_SMI:
            management_attempts += 1
        elif tuple(argv) == broker._CUDA_DRIVER_READINESS_QUERY:
            cuda_attempts += 1
            if cuda_attempts < 3:
                raise broker.AcceleratorUnavailableError(
                    "CUDA driver probe failed",
                    stage=failure_stage,
                )
        return broker.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(backend, "_run", delayed_cuda)

    assert backend.ensure_ready().ready is True
    assert management_attempts == 3
    assert cuda_attempts == 3
    assert clock.value < 1_000.0 + config.nvidia_readiness_timeout_sec


def test_poweroff_uses_persistence_daemon_without_legacy_mode_toggle(
    tmp_path, monkeypatch
) -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = broker.LinuxPciNvidiaBackend(config)

    nodes = {}
    for bdf in (
        config.root_port_bdf,
        config.branch_bdf,
        config.downstream_bridge_bdf,
        config.gpu_bdf,
        config.audio_bdf,
    ):
        node = tmp_path / bdf.replace(":", "_")
        node.mkdir()
        nodes[bdf] = node
    (nodes[config.branch_bdf] / "remove").write_text("", encoding="ascii")

    ready = broker.HardwareProbe(
        True,
        True,
        True,
        "nvidia",
        "snd_hda_intel",
        (),
    )
    off = broker.HardwareProbe(False, False, False, "", "", ())
    probes = iter((ready, off))
    commands = []
    writes = []

    monkeypatch.setattr(backend, "_pci_node", lambda bdf: nodes[bdf])
    monkeypatch.setattr(backend, "_validate_topology", lambda: None)
    monkeypatch.setattr(
        backend,
        "_driver",
        lambda node: "snd_hda_intel" if node == nodes[config.audio_bdf] else "",
    )
    monkeypatch.setattr(backend, "_client_names", lambda: ())
    monkeypatch.setattr(backend, "probe", lambda: next(probes))
    monkeypatch.setattr(
        backend,
        "_write",
        lambda path, value: writes.append((path, value)),
    )
    monkeypatch.setattr(broker.time, "sleep", lambda _seconds: None)

    def record_command(argv, *, timeout=30.0, check=True, failure_stage="fixed_command"):
        commands.append((tuple(argv), timeout, check, failure_stage))
        return broker.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(backend, "_run", record_command)

    assert backend.power_off().off is True
    assert not any(command[0][0] == broker._NVIDIA_SMI for command in commands)
    assert (
        (broker._SYSTEMCTL, "stop", config.persistence_service),
        30.0,
        True,
        "fixed_command",
    ) in commands
    assert any(path.name == "unbind" for path, _value in writes)
    assert any(path.name == "remove" for path, _value in writes)


def test_manager_and_protocol_preserve_bounded_failure_stage() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())

    class FailedBackend(_Backend):
        def ensure_ready(self):
            raise broker.AcceleratorUnavailableError(
                "cold enumeration is incomplete",
                stage="pci_enumeration",
            )

    manager = broker.AcceleratorManager(
        config,
        FailedBackend(broker, ready=False),
        start_monitor=False,
    )

    with pytest.raises(broker.AcceleratorUnavailableError):
        manager.acquire(owner_uid=1000, consumer="stt", ttl_sec=60)

    status = manager.status()
    assert status["last_error_type"] == "AcceleratorUnavailableError"
    assert status["last_error_stage"] == "pci_enumeration"


def test_failed_wake_remains_faulted_and_retry_reverifies_structural_hardware() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())

    class DelayedNvidiaBackend(_Backend):
        def ensure_ready(self):
            self.ensure_count += 1
            self.ready = True
            if self.ensure_count == 1:
                raise broker.AcceleratorUnavailableError(
                    "management interface is not ready",
                    stage="nvidia_readiness",
                )
            return self.probe()

    backend = DelayedNvidiaBackend(broker, ready=False)
    manager = broker.AcceleratorManager(
        config,
        backend,
        start_monitor=False,
    )

    with pytest.raises(broker.AcceleratorUnavailableError):
        manager.acquire(owner_uid=1000, consumer="stt", ttl_sec=60)

    failed_status = manager.status()
    assert failed_status["state"] == "fault"
    assert failed_status["readiness_verified"] is False
    assert failed_status["hardware"]["gpu_driver_ready"] is True
    assert failed_status["last_error_stage"] == "nvidia_readiness"

    acquired = manager.acquire(owner_uid=1000, consumer="stt", ttl_sec=60)
    assert backend.ensure_count == 2
    assert acquired["state"] == "ready"
    recovered_status = manager.status()
    assert recovered_status["readiness_verified"] is True
    assert recovered_status["last_error_stage"] == ""


def test_idle_poweroff_requires_zero_leases_guard_and_timeout() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile(automatic=True))
    clock = _Clock()
    backend = _Backend(broker)
    manager = broker.AcceleratorManager(
        config,
        backend,
        start_monitor=False,
        monotonic=clock,
        epoch=clock,
    )
    lease = manager.acquire(owner_uid=1000, consumer="tts", ttl_sec=60)

    clock.advance(30)
    assert manager.tick() is False
    assert backend.off_count == 0

    manager.release(owner_uid=1000, token=lease["lease_id"])
    clock.advance(9)
    assert manager.tick() is False
    clock.advance(2)
    assert manager.tick() is True
    assert backend.off_count == 1
    assert manager.status()["state"] == "off"


def test_expired_lease_becomes_idle_but_open_client_blocks_poweroff() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile(automatic=True))
    clock = _Clock()
    backend = _Backend(broker, clients=("python",))
    manager = broker.AcceleratorManager(
        config,
        backend,
        start_monitor=False,
        monotonic=clock,
        epoch=clock,
    )
    manager.acquire(owner_uid=1000, consumer="embedding", ttl_sec=10)
    clock.advance(11)

    # Lease expiry starts the idle window; it must not retroactively consume it.
    assert manager.tick() is False
    clock.advance(11)

    assert manager.tick() is False
    status = manager.status()
    assert status["state"] == "ready"
    assert status["lease_count"] == 0
    assert status["last_error_type"] == "AcceleratorBusyError"
    assert backend.off_count == 0


def test_runtime_rejects_unknown_request_fields_before_dispatch() -> None:
    broker = _broker_module()
    config = broker.AcceleratorConfig.from_dict("primary_cuda", _profile())
    backend = _Backend(broker)
    manager = broker.AcceleratorManager(config, backend, start_monitor=False)
    runtime = object.__new__(broker.BrokerRuntime)
    runtime.managers = {"primary_cuda": manager}
    runtime._request_times = broker.defaultdict(broker.deque)
    runtime._rate_lock = broker.threading.Lock()

    with pytest.raises(broker.AcceleratorConfigError, match="unsupported fields"):
        runtime.dispatch({
            "version": 1,
            "action": "status",
            "accelerator_id": "primary_cuda",
            "command": "modprobe arbitrary",
        }, peer_uid=1000)


def test_generic_client_lease_renews_and_releases_idempotently() -> None:
    client_module = _client_module()

    class RecordingClient:
        def __init__(self) -> None:
            self.requests: list[dict] = []

        def request(self, payload: dict) -> dict:
            self.requests.append(payload)
            if payload["action"] == "renew":
                return {
                    "ok": True,
                    "version": 1,
                    "state": "ready",
                    "lease_id": "opaque-lease-token",
                    "expires_at_epoch": 4_000_000_000.0,
                }
            return {"ok": True, "version": 1, "released": True}

    client = RecordingClient()
    lease = client_module.AcceleratorLease(
        client=client,
        accelerator_id="primary_cuda",
        lease_id="opaque-lease-token",
        ttl_seconds=60,
        expires_at_epoch=4_000_000_000.0,
    )

    assert lease.renew() == 4_000_000_000.0
    lease.release()
    lease.release()
    assert [request["action"] for request in client.requests] == ["renew", "release"]
    assert all(request["accelerator_id"] == "primary_cuda" for request in client.requests)


def test_accelerator_systemd_contract_is_bounded_and_separate() -> None:
    service = (SERVICE_ROOT / "systemd" / "openclaw-accelerator.service").read_text(
        encoding="utf-8"
    )
    assert "User=root" in service
    assert "RestrictAddressFamilies=AF_UNIX" in service
    assert "IPAddressDeny=any" in service
    assert "ProtectHome=true" in service
    assert "ProtectKernelModules=false" in service
    assert "ProtectKernelTunables=false" in service
    assert "ProtectProc=default" in service
    assert "TimeoutStopSec=300" in service
    assert "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_MODULE CAP_SYS_PTRACE" in service
    assert "InaccessiblePaths=-/etc/openclaw -/var/lib/openclaw" in service
    assert "ExecStart=/usr/bin/python3 /usr/lib/openclaw-accelerator/broker.py" in service
    assert "AF_INET" not in service
    assert "[Install]" in service
    assert "WantedBy=multi-user.target" in service

    socket_unit = (SERVICE_ROOT / "systemd" / "openclaw-accelerator.socket").read_text(
        encoding="utf-8"
    )
    assert "SocketGroup=openclaw-accelerator" in socket_unit
    assert "SocketMode=0660" in socket_unit
    assert "FileDescriptorName=accelerator" in socket_unit
    assert "Accept=no" in socket_unit

    sysusers = (SERVICE_ROOT / "systemd" / "openclaw-accelerator.sysusers").read_text(
        encoding="utf-8"
    )
    assert "g openclaw-accelerator -" in sysusers
    assert "m openclaw openclaw-accelerator" in sysusers

    tmpfiles = (SERVICE_ROOT / "systemd" / "openclaw-accelerator.tmpfiles").read_text(
        encoding="utf-8"
    )
    assert (
        "d /run/openclaw-accelerator 0750 root openclaw-accelerator -"
        in tmpfiles
    )


def test_public_contract_matches_broker_ids_ttls_and_states() -> None:
    contract_root = SERVICE_ROOT.parents[1] / "contracts" / "accelerator-v1"
    request = json.loads(
        (contract_root / "request.schema.json").read_text(encoding="utf-8")
    )
    response = json.loads(
        (contract_root / "response.schema.json").read_text(encoding="utf-8")
    )

    assert request["$defs"]["id"]["pattern"] == "^[a-z][a-z0-9_.-]{0,63}$"
    assert "ttl_sec" not in request["$defs"]["acquire"]["required"]
    assert "ttl_sec" not in request["$defs"]["renew"]["required"]
    assert response["$defs"]["success"]["properties"]["state"]["enum"] == [
        "off",
        "attaching",
        "ready",
        "degraded",
        "detaching",
        "fault",
    ]
