[Setup]
AppId={{8A92B4E1-5F3C-4D9E-9A1B-7C6D5E4F3A2B}
AppName=Browz Standalone Browser
AppVersion=1.0.2
AppPublisher=Browz Security & Performance
DefaultDirName={autopf}\Browz
DefaultGroupName=Browz Browser
UsePreviousAppDir=yes
UsePreviousGroup=yes
CloseApplications=force
RestartApplications=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Browz-Standalone-Installer-1.0.0
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\Browz-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Browz Browser"; Filename: "{app}\Browz.exe"
Name: "{autodesktop}\Browz Browser"; Filename: "{app}\Browz.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Browz.exe"; Description: "Launch Browz Standalone Browser"; Flags: nowait postinstall skipifsilent
