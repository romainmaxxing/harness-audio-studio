# Audio studio

A page extension for [Harness Maxxing](https://harness-maxxing.com): record voice takes from the browser, edit them
on one timeline and export a single MP3, without leaving the app.

- **Record** takes with the microphone of your choice, an input gain and a level meter (noise reduction and auto
  gain can be turned off for a clean signal).
- **Edit** on a timeline with waveforms: drag the edges of a take to trim it, drag its top strip to reorder, select a
  range and press Delete, split at the playhead (S), change the gain of a take, undo / redo. Edits never touch the
  recorded files.
- **Export** one MP3 (192 kbps) with the takes joined, the trims applied and the loudness of a voice-over
  (−16 LUFS).
- Keyboard: R record / stop, Space play / pause, S split, Delete, Ctrl+Z / Ctrl+Shift+Z, arrows to move the
  playhead, Ctrl + wheel to zoom. Works on a phone (pinch to zoom).
- English and French, following the language of the app.

## What it needs

- Harness Maxxing with extensions API 1.
- `ffmpeg` and `ffprobe` on the server (`apt install ffmpeg`).
- The browser asks for microphone access; it is only given on HTTPS (or `localhost`).
- No key, no account, no other service.

## What it stores and sends

Everything stays on your server. Recordings are saved in `~/audios/<project id>/` of the user that runs Harness
(`/root/audios` on a standard install): `project.json`, the takes (`takes/*.webm`) and the last MP3 export. The
folder is outside the workspace on purpose, so the memory backup never carries audio. Deleted recordings go to
`~/audios/.trash/`; empty it by hand.

The page plays the takes and downloads the MP3 through the app's file viewer, so the audio folder must be inside the
**files root** (Settings → General, `/root` by default). To keep recordings elsewhere, set `STUDIO_AUDIO_DIR` in the
environment of the `claude-maxxing` service (`systemctl edit claude-maxxing`) to a folder inside the files root.

Nothing is sent outside the server. The extension has server code (`api.py`): it writes in the audio folder and runs
`ffmpeg` there, nothing else.

## Install

```bash
git clone https://github.com/romainmaxxing/harness-audio-studio /root/maxxing/extensions/studio-audio
```

(Replace `/root/maxxing` with your workspace.) The **Audio studio** page appears under **Extensions** in the
sidebar; click its pin to give it its own entry. Run `git pull` in the folder to update it.

## Remove

Turn it off in Settings → Extensions, or delete the folder `<workspace>/extensions/studio-audio`. Your recordings
stay in `~/audios`; delete that folder too if you do not want them any more.

## License

MIT, see [LICENSE](LICENSE).
