# Fixtures

## Public (`fixtures/public/cache/`)

Freely redistributable images, downloaded by `pnpm fixtures` and verified by
SHA-256. Never committed; CI downloads them on every run.

| File | Source | License |
|---|---|---|
| `freedos98-2hd.hdm` | [FreeDOS(98)](https://github.com/lpproj/fdkernel) 2HD boot disk | GPLv2 |

## Private (`fixtures/private/`)

Your own dumps of commercial software, for local end-to-end tests only.
This folder is git-ignored, and `scripts/check-no-images.sh` (run as a
pre-commit hook and in CI) rejects any disk image or ROM in the repository.

```
fixtures/private/
  shizuku/        # e.g. Shizuku (Leaf, 1996) disks: *.fdi / *.d88 / *.hdm / *.hdi
  rom/            # optional real ROMs: bios.rom, font.rom, sound.rom, itf.rom, 2608_*.wav
```

Tests that need private fixtures are skipped when the files are missing.
