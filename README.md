# Block Quest v0.12

## Gameplay fix
The piece tray is now explicitly clickable/tappable.

### Level 1
- 3×3 board
- 3 visible connected pieces (4, 2, and 3 blocks)
- Select a piece
- Tap a board square to place it
- Rotate button
- Drag/drop is still supported

The player no longer depends only on drag-and-drop.

## Run (easiest)
Double-click **`START_GAME.bat`** in this folder. It starts both servers and opens the game in your browser.

## Run (manual)
Backend:
```powershell
cd D:\Game\block_quest_v12
py -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend in another PowerShell:
```powershell
cd D:\Game\block_quest_v12
py -m http.server 5500 -d frontend
```

Open in browser (do NOT double-click index.html):
http://localhost:5500

Use Ctrl+F5 after switching versions.

## Stages and ranking
Each stage contains 10 levels. Completing Level 10 starts the next stage at Level 1. Signed-in players' stage, level, board, score, and tools are saved to the server as they play. The leaderboard ranks all accounts by best stage, then level, then score. Guest progress remains temporary.

## Password recovery
Password reset email requires an SMTP account. Set these variables in PowerShell before starting the game:
```powershell
$env:SMTP_HOST = "smtp.gmail.com"
$env:SMTP_PORT = "587"
$env:SMTP_USERNAME = "your-sender@example.com"
$env:SMTP_PASSWORD = "your-mail-provider-app-password"
$env:SMTP_FROM = "TileTuck <your-sender@example.com>"
$env:PUBLIC_APP_URL = "http://localhost:5500"
.\START_GAME.bat
```
Use your mail provider's SMTP host and credentials; Gmail accounts should use an app password. The `PUBLIC_APP_URL` must be reachable by the person opening the email link. `localhost` is suitable only when testing on the same computer; use the deployed frontend URL for remote users.

Reset links expire after 30 minutes and can be used once. Password recovery stays unavailable until SMTP is configured.

## Android APK development
The Android app uses Capacitor and packages the existing `frontend` as a native WebView app.

Build a debug APK in PowerShell:
```powershell
cd D:\Game\block_quest_v12
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
npm install
npm run android:apk:debug
```
The APK is written to `android\app\build\outputs\apk\debug\app-debug.apk`. Open the native project in Android Studio with `npm run android:open`.

On the Android emulator, the API URL defaults to `http://10.0.2.2:8000`. Start the backend separately with `run_backend.bat`. On a physical phone, connect both devices to the same network, open **Game server connection** on the login screen, and enter the computer's LAN address, for example `http://192.168.1.20:8000`; allow port 8000 through the computer firewall if prompted. Use HTTPS for a production backend; cleartext HTTP is enabled in this development APK only.
