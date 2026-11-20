; PrintSetu Setup — the single-file Windows installer for the Printer App.
;
; Unlike the per-shop ZIP (printsetu-backend/src/printers/agent-package.service.ts),
; this installer is the same for every shop: it asks for the one-time setup
; code shown on the shop's dashboard and trades it for an agent credential at
; POST <BackendHttpUrl>/agent/pair. Nothing shop-specific is baked in, so one
; signed build can be handed to everyone.
;
; It installs the agent the same way Install.bat does — as the PrintSetuAgent
; startup task (service/Install-Task.ps1, see there for why a task and not a
; Windows service) — only with every PowerShell window hidden.
;
; Build: npm run build:installer (see scripts/build-windows-installer.sh).
; Silent install for remote setup: PrintSetu-Setup.exe /VERYSILENT /CODE=K7M4-2QXP

#ifndef BackendHttpUrl
  #define BackendHttpUrl "http://localhost:53100/api"
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef RepoRoot
  #define RepoRoot "..\.."
#endif

#define TaskName "PrintSetuAgent"
#define ExeName "PrintSetuAgent.exe"

[Setup]
; Keep this AppId forever — it's how a newer Setup finds and upgrades an older install.
AppId={{6F0D3C1E-4B8A-4E57-9C2A-7B1E5D9A2F10}
AppName=PrintSetu Printer App
AppVersion={#AppVersion}
AppPublisher=PrintSetu
DefaultDirName={autopf}\PrintSetu
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
OutputBaseFilename=PrintSetu-Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName=PrintSetu Printer App
UninstallDisplayIcon={app}\{#ExeName}
CloseApplications=no

[Files]
Source: "{#RepoRoot}\release\bundle\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\service\Install-Task.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\service\Uninstall-Task.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\service\README.txt"; DestDir: "{app}"; Flags: ignoreversion
; SumatraPDF (GPL v3) is embedded in PrintSetuAgent.exe; its license goes alongside.
Source: "{#RepoRoot}\vendor\SumatraPDF-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Uninstall-Task.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTask"

[UninstallDelete]
; Written at run time, so Inno doesn't know about them on its own.
Type: files; Name: "{app}\agent.config.json"
Type: files; Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\downloads"
; Reports waiting to be sent and the order in progress (job-state.ts).
Type: filesandordirs; Name: "{app}\state"
; Left by an automatic update (updater.ts).
Type: files; Name: "{app}\PrintSetuAgent.exe.old"
Type: files; Name: "{app}\PrintSetuAgent.exe.new"

[Code]
const
  BackendHttpUrl = '{#BackendHttpUrl}';
  ConnectedMarker = 'Connected to PrintSetu backend';
  ConnectWaitSeconds = 20;

var
  CodePage: TInputQueryWizardPage;
  AgentId, AgentSecret, BackendWsUrl, PairedHttpUrl: String;
  Connected: Boolean;

function ConfigPath(): String;
begin
  Result := AddBackslash(WizardDirValue()) + 'agent.config.json';
end;

{ Reinstalling or updating keeps this computer's existing link to the shop. }
function AlreadyPaired(): Boolean;
begin
  Result := FileExists(ConfigPath());
end;

{ Uppercase letters and digits only, so "k7m4-2qxp" and "K7M4 2QXP" both work. }
function NormalizeCode(const S: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := UpperCase(S[I])[1];
    if ((C >= 'A') and (C <= 'Z')) or ((C >= '0') and (C <= '9')) then
      Result := Result + C;
  end;
end;

{ Computer names are letters, digits and dashes — drop anything else rather than JSON-escape it. }
function SafeHostname(): String;
var
  I: Integer;
  S: String;
begin
  S := GetComputerNameString();
  Result := '';
  for I := 1 to Length(S) do
    if Pos(S[I], 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.') > 0 then
      Result := Result + S[I];
end;

{ Reads a string field from the flat JSON the backend returns. Values here
  (ids, base64url secrets, URLs, plain messages) never contain escaped quotes. }
function JsonString(const Json, Key: String): String;
var
  Marker: String;
  P: Integer;
  Rest: String;
begin
  Result := '';
  Marker := '"' + Key + '":"';
  P := Pos(Marker, Json);
  if P = 0 then Exit;
  Rest := Copy(Json, P + Length(Marker), MaxInt);
  P := Pos('"', Rest);
  if P > 0 then Result := Copy(Rest, 1, P - 1);
end;

function Pair(const Code: String; var ErrorText: String): Boolean;
var
  Http: Variant;
  Body, Response: String;
  Status: Integer;
begin
  Result := False;
  Body := '{"code":"' + Code + '","hostname":"' + SafeHostname() + '"}';
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.SetTimeouts(10000, 10000, 15000, 15000);
    Http.Open('POST', BackendHttpUrl + '/agent/pair', False);
    Http.SetRequestHeader('Content-Type', 'application/json');
    Http.Send(Body);
    Status := Http.Status;
    Response := Http.ResponseText;
  except
    ErrorText := 'Could not reach PrintSetu. Check that this computer is connected to the internet, then try again.';
    Exit;
  end;

  if Status = 429 then
  begin
    ErrorText := 'Too many tries. Please wait a minute, then try again.';
    Exit;
  end;
  if (Status < 200) or (Status >= 300) then
  begin
    ErrorText := JsonString(Response, 'message');
    if ErrorText = '' then
      ErrorText := 'Something went wrong (error ' + IntToStr(Status) + '). Please try again or contact PrintSetu support.';
    Exit;
  end;

  AgentId := JsonString(Response, 'agentId');
  AgentSecret := JsonString(Response, 'agentSecret');
  BackendWsUrl := JsonString(Response, 'backendWsUrl');
  PairedHttpUrl := JsonString(Response, 'backendHttpUrl');
  if (AgentId = '') or (AgentSecret = '') then
  begin
    ErrorText := 'PrintSetu sent an unexpected reply. Please contact PrintSetu support.';
    Exit;
  end;
  Result := True;
end;

procedure InitializeWizard();
begin
  CodePage := CreateInputQueryPage(wpWelcome,
    'Enter your setup code',
    'This links this computer to your PrintSetu shop.',
    'On your PrintSetu dashboard, open the Printer App page and click "Get setup code". ' +
    'Type the code shown there below. Each code works once and only for 15 minutes.');
  CodePage.Add('Setup code:', False);
  CodePage.Values[0] := ExpandConstant('{param:CODE|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = CodePage.ID) and AlreadyPaired();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code, ErrorText: String;
begin
  Result := True;
  if CurPageID <> CodePage.ID then Exit;

  { Already paired on an earlier pass (the user went Back); a code only works once. }
  if AgentId <> '' then Exit;

  Code := NormalizeCode(CodePage.Values[0]);
  if Length(Code) <> 8 then
  begin
    MsgBox('The setup code has 8 letters and numbers, like K7M4-2QXP. Please check it and try again.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  WizardForm.NextButton.Enabled := False;
  try
    Result := Pair(Code, ErrorText);
  finally
    WizardForm.NextButton.Enabled := True;
  end;
  if not Result then MsgBox(ErrorText, mbError, MB_OK);
end;

function PowerShell(const Args: String): Integer;
begin
  if not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass ' + Args, '',
              SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
end;

{ An agent that is already running holds PrintSetuAgent.exe open, so stop it
  before the files are replaced. Also catches a copy from an older ZIP install. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrorText: String;
begin
  { A silent install (/SILENT /CODE=K7M4-2QXP) never shows the code page, so pair here. }
  if WizardSilent() and not AlreadyPaired() and (AgentId = '') then
    if not Pair(NormalizeCode(ExpandConstant('{param:CODE|}')), ErrorText) then
    begin
      Result := ErrorText;
      Exit;
    end;

  PowerShell('-Command "Stop-ScheduledTask -TaskName ''{#TaskName}'' -ErrorAction SilentlyContinue; ' +
             'Get-Process -Name ''PrintSetuAgent'' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; ' +
             'Start-Sleep -Seconds 1"');
  Result := '';
end;

procedure WriteCredential();
var
  Dir: String;
begin
  Dir := ExpandConstant('{app}');
  if PairedHttpUrl = '' then PairedHttpUrl := BackendHttpUrl;
  SaveStringToFile(Dir + '\agent.config.json',
    '{' + #13#10 +
    '  "agentId": "' + AgentId + '",' + #13#10 +
    '  "agentSecret": "' + AgentSecret + '"' + #13#10 +
    '}' + #13#10, False);
  SaveStringToFile(Dir + '\.env',
    'PRINTSETU_BACKEND_WS_URL=' + BackendWsUrl + #13#10 +
    'PRINTSETU_BACKEND_HTTP_URL=' + PairedHttpUrl + #13#10, False);
  { The agent runs as SYSTEM; nobody else on this PC needs to read the secret. }
  PowerShell('-Command "icacls ''' + Dir + '\agent.config.json'' /inheritance:r /grant:r ''*S-1-5-18:F'' ''*S-1-5-32-544:F''"');
end;

function FileSize(const FileName: String): Integer;
var
  Content: AnsiString;
begin
  Result := 0;
  if LoadStringFromFile(FileName, Content) then Result := Length(Content);
end;

{ Watches the agent's log for its first successful connection, like
  Check-Connection.ps1 does. Runs in a hidden PowerShell so the wizard keeps
  responding while it waits (Exec pumps window messages; Sleep here would not). }
procedure WaitForConnection(const LogFile: String; StartAt: Integer);
var
  ExitCode: Integer;
begin
  WizardForm.StatusLabel.Caption := 'Connecting to PrintSetu...';
  ExitCode := PowerShell('-Command "' +
    'for ($i = 0; $i -lt ' + IntToStr(ConnectWaitSeconds * 2) + '; $i++) { ' +
      'try { $b = [IO.File]::ReadAllBytes(''' + LogFile + '''); ' +
        'if ($b.Length -gt ' + IntToStr(StartAt) + ' -and ' +
            '[Text.Encoding]::UTF8.GetString($b, ' + IntToStr(StartAt) + ', $b.Length - ' + IntToStr(StartAt) + ').Contains(''' + ConnectedMarker + ''')) { exit 0 } ' +
      '} catch { } ' +
      'Start-Sleep -Milliseconds 500 ' +
    '}; exit 1"');
  Connected := ExitCode = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogFile: String;
  StartAt: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  if AgentId <> '' then WriteCredential();

  { Only look at log lines written after this start, not ones left by an earlier install. }
  LogFile := ExpandConstant('{app}\logs\agent.log');
  StartAt := FileSize(LogFile);

  WizardForm.StatusLabel.Caption := 'Starting the Printer App...';
  if PowerShell('-File "' + ExpandConstant('{app}\Install-Task.ps1') + '"') <> 0 then
  begin
    MsgBox('The Printer App was copied but could not be started. Please restart this computer, ' +
           'or contact PrintSetu support.', mbError, MB_OK);
    Exit;
  end;

  WaitForConnection(LogFile, StartAt);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpFinished then Exit;
  if Connected then
    WizardForm.FinishedLabel.Caption :=
      'Your printer is connected to PrintSetu.' + #13#10#13#10 +
      'On your dashboard, choose which printer on this computer should print orders. ' +
      'The Printer App runs quietly in the background and starts with the computer.'
  else
    WizardForm.FinishedLabel.Caption :=
      'The Printer App is installed and running, but has not confirmed the connection yet.' + #13#10#13#10 +
      'This can take a minute on the first run. Check your PrintSetu dashboard — if the printer ' +
      'still is not Online, check the internet connection or contact PrintSetu support.';
end;
