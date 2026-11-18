# NG-ILMF Android Native Wrapper (OPPO CPH1911 / Android 11)

This native Android Kotlin wrapper hosts the `NG-ILMF Mobile Command Center` WebView and provides genuine Android Framework Storage Access Framework (`ACTION_OPEN_DOCUMENT_TREE`) integration via `window.NgIlmfAndroidBridge`.

## 1. Running the Local Command Center Server in Termux (On OPPO CPH1911)
1. Install Termux from F-Droid on OPPO CPH1911 (Android 11).
2. Inside Termux:
   ```bash
   pkg update && pkg upgrade -y
   pkg install nodejs-lts git -y
   ```
3. Copy or clone the project directory onto the device and install dependencies:
   ```bash
   npm install
   npm run build
   NODE_ENV=production npm run dev
   ```
   The local server listens on `http://127.0.0.1:3000`.

## 2. Building the Android Wrapper APK
1. Open the `/android` directory in **Android Studio** (or use Gradle CLI with Android SDK 34 installed):
   ```bash
   cd android
   ./gradlew assembleDebug
   ```
2. The generated APK will be located at:
   `android/app/build/outputs/apk/debug/app-debug.apk`
3. Install on OPPO CPH1911 via USB debugging (`adb install -r app-debug.apk`) or direct APK installation.

## 3. Verifying Real SD Card Access via SAF (`ACTION_OPEN_DOCUMENT_TREE`)
1. Launch **NG-ILMF Command Center** on the OPPO CPH1911.
2. Open **Android Bridge / Storage Environments** tab.
3. Tap **Choose Archive Folder (ACTION_OPEN_DOCUMENT_TREE)**, navigate to the SD Card (`857A-1AED`), and grant access to your chosen archive folder.
4. `SafStorageBridge` persists the `content://` URI permission via `takePersistableUriPermission`, checks `DocumentFile.canRead()` / `canWrite()`, runs the temporary SHA-256 read/write/compare/delete probe, and attests real verification to `POST /api/v1/android/attest`.

## 4. Capabilities That Can ONLY Be Verified on Real Android Hardware
- Actual `ACTION_OPEN_DOCUMENT_TREE` system picker UI and user grant flow on ColorOS / Android 11.
- `contentResolver.takePersistableUriPermission` across device reboots and SD Card unmount/remount cycles.
- Scoped Storage / MediaProvider behavior on physical SD Card `857A-1AED`.
- Termux package presence (`com.termux`) and localhost loopback connectivity from WebView to Termux Node process.
