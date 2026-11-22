# CFE Shogi

CFE Shogi is a free, open-source Japanese shogi PWA built around a **fail-closed certificate layer**.

## Source snapshot

Download the source distribution: [CFE-Shogi-source-v0.1.0.tar.gz](CFE-Shogi-source-v0.1.0.tar.gz)

The archive contains the browser PWA, reference shogi rules, CFE certificate envelope and fail-closed verifier, Governor, Supabase schema and move-validation Edge Function, YaneuraOu WebAssembly build workflow, tests, documentation, and third-party notices.

## Local development

- Node.js 22 or newer
- `npm test`
- `npm run check`
- Serve this directory through localhost or HTTPS and open `index.html`.
- On iPhone/iPad: Safari → Share → Add to Home Screen.

Local two-player play and record export/import work without an account. Online play requires a separately configured Supabase project. AI play requires building the optional YaneuraOu WASM artifact and checking it on an actual iOS device.

## CFE safety boundary

The current version does **not** implement generalized proof extraction from a DFPN proof tree. It implements a versioned certificate format and a conservative verifier interface. E/H certificates do not cut search unless an independent verifier explicitly accepts them; M/P certificates remain advisory. This prevents heuristic footprints from becoming false proofs.

## Scope and limitations

This is an engineering foundation, **not a tournament-ready or world-championship-strength engine**. The reference rules implementation has unit tests but has not yet received independent rule-conformance certification. Online server deployment and the YaneuraOu WASM build are setup/build tasks; they are not claimed to be live in this repository snapshot.

No ads, subscriptions, in-app purchases, or paid feature gates are included. Hosting providers' free tiers have quotas and may change; this project does not promise unlimited free hosting or unlimited player capacity.

## License

The project is GPL-3.0-only. See [LICENSE](LICENSE), [docs/licensing.md](docs/licensing.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
