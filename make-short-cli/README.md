# Remotion video

This project comes from https://github.com/remotion-dev/template-tiktok

<p align="center">
  <a href="https://github.com/remotion-dev/logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-dark.apng">
      <img alt="Animated Remotion Logo" src="https://github.com/remotion-dev/logo/raw/main/animated-logo-banner-light.gif">
    </picture>
  </a>
</p>

Welcome to your Remotion project!

## Commands

**Install Dependencies**

```console
bun install
```

**Start Preview**

```console
bun run dev
```

**Render video**

```console
bun run render
```

**Upgrade Remotion**

```console
bun run upgrade
```

## Captioning

Generate subtitles from a video and write the output JSON to `out/`.

```console
bun run create-subtitles <path-to-video-file>
```

Example using one of the repository test videos:

```console
bun run create-subtitles ./examples/winner01.mp4
```

Generate subtitles and render a captioned output video in one command:

```console
bun run add-subtitle-to-video ./examples/winner01.mp4
```

If you already have a subtitles JSON file, provide it and skip subtitle generation:

```console
bun run add-subtitle-to-video ./examples/winner01.mp4 --subtitle ./out/winner01.json
```

To override the active subtitle highlight color:

```console
bun run add-subtitle-to-video ./examples/winner01.mp4 --subtitle-color "#FFAA00"
```

The provided JSON is validated before rendering.

Pick the most viral subtitle segment using an LLM and write a short-only JSON into `public/`:

```console
bun run create-short ./out/winner02.json --seconds 20
```

Generate subtitles, select short parts, cut/join the short video, and render captioned output in one command:

```console
bun run short ./examples/winner02.mp4 --seconds 20
```

Optional flags:

- `--model <name>`: Override model per run (for example `--model gpt-5-mini`)
- `--max-iterations <1-10>`: Limit optimization loop attempts (default: `3`)
- `--subtitle-color <hex>`: Set active subtitle highlight color (`#RRGGBB` or `RRGGBB`, default: current green)

The selector can choose one or multiple chronological subtitle segments as long as the combined duration fits `--seconds` and the final short remains understandable.

Environment variables for the short selector:

- `OPENAI_BASE_URL` (default: `http://localhost:3009`)
- `OPENAI_SHORT_MODEL` (default: `gpt-5-mini`)
- `OPENAI_API_KEY` (required only when calling official OpenAI API)

The `short` command creates:

- `out/<video-name>.json`
- `out/<video-name>_<seconds>s.selection.json`
- `out/<video-name>_<seconds>s.mp4`
- `out/<video-name>_<seconds>s.json`
- `out/<video-name>_<seconds>s-captioned.mp4`

Before rendering, it cleans `public/` and copies the required runtime files there:

- `public/<video-name>.<ext>`
- `public/<video-name>.json`

## Configure Whisper.cpp

Captioning installs Whisper.cpp into `whisper.cpp/` and uses model `medium.es` by default.
You can override this without editing code:

```console
WHISPER_MODEL=tiny WHISPER_LANG=es bun run create-subtitles ./examples/winner01.mp4
```

### Non-English languages

For non-English languages, use a model without `.en` suffix and set `WHISPER_LANG`.

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help on our [Discord server](https://remotion.dev/discord).

## Issues

Found an issue with Remotion? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
