' Launch the DSH live-thinking floating card without a console window.
' Copied into the user's Startup folder by the plugin's installer step.
Dim fso, shell, here, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "overlay.ps1")
If Not fso.FileExists(script) Then
  ' The Startup copy lives outside the package: fall back to the install path.
  script = "C:\Users\lenovo\Desktop\dsh-live-thinking\overlay.ps1"
End If
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
