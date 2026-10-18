# Repair roadmap
- [x] Dataset selection, cache races, pair identity and validation
- [x] Consistent expression summaries, annotation colors and merged-DE provenance
- [x] Stream lengths, stage cancellation/retry, worker errors and storage failures
- [x] Honest exports, dormant analysis edge cases and unused-code cleanup
- [x] Regression tests, browser verification and dependency security scan

Verification boundary: browser checks cover uploaded and split-worker fixtures, annotation changes, filtering, exports and merging; the full production matrix has not been stress-tested. Dependency checks report no known production vulnerabilities; automated deep security analysis was not run.