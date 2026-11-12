> **Arsip historis.** Dokumen ini mempertahankan temuan pada saat ditulis; status dan rencana di bawah dapat berbeda dari kode terbaru. Lihat [README](../../README.md) untuk panduan saat ini.

# Gemini rate-limit audit source

- Official source: https://ai.google.dev/gemini-api/docs/rate-limits
- Retrieved: 2026-08-22
- Key findings: Gemini evaluates requests against requests-per-minute, input-tokens-per-minute, and requests-per-day limits. Exceeding any one produces a rate-limit error. Limits apply per Google project, not per API key. Requests-per-day reset at midnight Pacific time.
- Related troubleshooting source: https://ai.google.dev/gemini-api/docs/troubleshooting
- Key guidance: retry transient 429 responses with exponential backoff and jitter; do not retry client errors such as 400 or 403.
