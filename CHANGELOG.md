# Changelog

## 2026-05-28

- Added a fallback for `hy-smi` collection through a login shell. This supports servers where `hy-smi` is only available after shell startup scripts load the DTK environment.
- Verified local access to `10.17.26.107` and prepared the same collection behavior for the deployed service.

## 2026-05-27

- Added compact wide-screen server cards and fixed card content overflow.
- Increased default SSH/collection timeout to 20 seconds for slower NVIDIA `nvidia-smi` responses.
- Added GPU/DCU model persistence and manual model refresh behavior.
- Added server grouping and group filters.
- Added deployment documentation and UI screenshots to the README.
