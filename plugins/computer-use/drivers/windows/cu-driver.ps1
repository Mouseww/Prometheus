# Starts the Windows Computer Use driver. Compiles driver.cs with the C# compiler that ships with
# .NET Framework the first time (or whenever the source changes), caches the DLL, then hands
# stdin/stdout to the driver's JSON-RPC loop. Nothing else may write to stdout.
param(
	[Parameter(Mandatory = $true)][string]$Source,
	[Parameter(Mandatory = $true)][string]$CacheDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.Substring(0, 16)
$dll = Join-Path $CacheDir "cu-driver-$hash.dll"
if (-not (Test-Path -LiteralPath $dll)) {
	New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
	$tmp = Join-Path $CacheDir "cu-driver-$hash.$PID.dll"
	Add-Type -LiteralPath $Source -OutputAssembly $tmp -OutputType Library `
		-ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions
	Move-Item -LiteralPath $tmp -Destination $dll -Force
}
$asm = [Reflection.Assembly]::LoadFrom($dll)
[void]$asm.GetType('PrometheusCU.Driver').GetMethod('Run').Invoke($null, @())
