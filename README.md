# AI Usage Bar for Windows

Workspace ini menyiapkan aplikasi Windows taskbar bar untuk memantau usage/limit AI coding tools berdasarkan CodexBar.

## Hasil

Saya memakai Windows-native port yang juga direferensikan oleh README CodexBar upstream:

- Upstream macOS: <https://github.com/steipete/CodexBar>
- Windows port: <https://github.com/nesszer/Win-CodexBar>
- Versi yang diambil: `v0.48.0`
- File portable: `dist/CodexBar-0.48.0-portable.exe`
- Checksum resmi: `dist/CodexBar-0.48.0-portable.exe.sha256`
- CLI provider usage: `dist/codexbar-cli.exe` (built from Win-CodexBar `codexbar` crate)
- Wrapper taskbar: Electron app di repo ini, menempel di area taskbar tanpa tray icon tambahan.

## Cara menjalankan

Jalankan taskbar wrapper:

```powershell
npm install
npm start
```

Wrapper akan muncul langsung di taskbar area. Klik bar untuk expand/collapse; tombol `Open CodexBar` menjalankan portable app.

Atau double-click portable app langsung:

```text
dist/CodexBar-0.48.0-portable.exe
```

Atau jalankan:

```bat
scripts\run-codexbar.cmd
```

Validasi artifact lokal:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-codexbar.ps1
```

Setelah app terbuka:

1. Cari icon CodexBar di system tray Windows.
2. Klik icon tray.
3. Buka Settings -> Providers.
4. Enable provider yang dipakai, misalnya Codex, Claude, OpenRouter, OpenAI, DeepSeek, dll.
5. Untuk Codex, pastikan Codex CLI/OAuth sudah login di Windows user yang sama.

## Verifikasi checksum

Checksum sudah diverifikasi saat download:

```text
ee26fcde97cf38c68c920fcb7ab26a3da2931e8bf16adbb0966c336994c421c9
```

Perintah manual dari Git Bash:

```bash
cd /c/Users/MAHDI/Documents/Autopreneur/ai-usage-bar
sha256sum dist/CodexBar-0.48.0-portable.exe
cat dist/CodexBar-0.48.0-portable.exe.sha256
```

## Catatan

- Artifact release ini unsigned, sesuai catatan upstream Win-CodexBar. Kalau Windows SmartScreen muncul, cocokkan SHA-256 di atas.
- Portable build tidak perlu install. Kalau ingin Start Menu/autostart resmi, pakai installer release atau `winget install Finesssee.Win-CodexBar`.
- Source CodexBar macOS sudah di-clone ke `upstream-CodexBar/` untuk referensi arsitektur.


