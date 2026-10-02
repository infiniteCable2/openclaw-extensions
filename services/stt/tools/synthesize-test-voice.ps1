param(
    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $german = $synth.GetInstalledVoices() |
        Where-Object { $_.VoiceInfo.Culture.Name -eq 'de-DE' } |
        Select-Object -First 1
    if ($null -eq $german) {
        throw 'No offline German SAPI voice is installed.'
    }
    try {
        $synth.SelectVoice($german.VoiceInfo.Name)
    } catch {
        throw 'A German SAPI voice was listed but could not be opened.'
    }
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synth.SetOutputToWaveFile($OutputPath, $format)
    $synth.Speak('Heute ist ein guter Tag für einen kurzen Sprachtest.')
    $synth.SetOutputToNull()
} finally {
    $synth.Dispose()
}
