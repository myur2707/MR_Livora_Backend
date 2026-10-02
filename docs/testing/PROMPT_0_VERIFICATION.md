# Prompt 0 verification

Verified on **2026-10-02, Asia/Calcutta**, using Windows, Node **24.21.0**, npm **11.19.0**, and a fresh clone of `dev-sprint-1` from GitHub at commit `5f6cae7`. The clone had no local environment file or previously installed dependencies. The original workspace's environment files and database data were preserved.

The Angular repository still contains only its initial README, license and ignore file; frontend package/build checks are not applicable until the Angular foundation is implemented. No later roadmap features were added for these checks.

| Requested check                                                      | Result      | Evidence                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh clone follows README to install and run checks                 | PASS        | `npm ci` and `npm run check` succeeded in the fresh GitHub clone, without a database connection                                                                                                                                     |
| Applicable lint, typecheck, test and build scripts exist and succeed | PASS        | All four scripts exist; lint, strict types, 7 offline tests and build passed; formatting and 5-file migration validation also passed                                                                                                |
| `.env.example` has placeholders, no real credentials                 | PASS        | Password is `replace_with_local_password`; template reviewed and secret-scanned                                                                                                                                                     |
| Git ignores `.env`, outputs and local secrets                        | PASS        | Created fake `.env`, fake PEM, local fake-credential JSON and build-output probes; `git check-ignore` and `git status --short --ignored` confirmed they were ignored                                                                |
| AGENTS.md contains and references engineering rules                  | PASS        | Repository AGENTS.md directs future work to the bundled engineering/security baseline; README references AGENTS.md; both were present in the fresh clone                                                                            |
| Fake secret in local `.env` stays ignored                            | PASS        | `.env` contained an explicitly fake verification value; normal Git status remained clean                                                                                                                                            |
| Temporary TypeScript error fails, then is reverted                   | PASS        | A string assigned to a number in a temporary source file produced TS2322; file removed and typecheck passed afterward                                                                                                               |
| Temporary lint violation fails, then is reverted                     | PASS        | Temporary explicit `any` triggered `@typescript-eslint/no-explicit-any`; file removed and lint passed afterward                                                                                                                     |
| Production HTTP error response hides stack trace                     | PENDING API | Step 1 has no HTTP API. Separately verified the existing compiled CLI in `NODE_ENV=production`: a deliberately failed loopback connection returned a generic error with no stack, SQL, driver details, filesystem paths or password |
| No global lint/security suppression to pass checks                   | PASS        | Strict/noImplicitAny/strictNullChecks are enabled in effective TypeScript config; effective ESLint rules retain error severity; no blanket disable directives were found in source/config; secret scanning remains active           |

All temporary source, fake-secret and output probes were removed. The verification clone's ordinary Git status was clean afterward. The primary workspace was not used for deliberate failure injections.

## GitHub Actions verification and fix

The first published run passed install, formatting/lint/typecheck/unit tests/build/migration validation, 15 MySQL integration tests, migration status/no-op reapplication and dependency audit. Its scanner setup failed because `rg` was not installed on GitHub's Ubuntu runner; there were no secret findings from that failed step because scanning had not started.

Commit **`b7eccd6`** replaces the checksum selector with standard `awk` and explicitly uses Bash with pipe failure checking. SHA-256 verification, the version-pinned Gitleaks binary and full repository-history scanning remain enabled. Workflow syntax and formatting checks passed locally.

The corrected [GitHub Actions run](https://github.com/myur2707/MR_Livora_Backend/actions/runs/36991679898) **completed successfully** at commit `b7eccd6`, including real MySQL tests, dependency audit and secret scanning. Local Gitleaks also reported no leaks in the fresh-clone source and all four commits of the original branch history.

## Remaining check

Test a real production HTTP error response when the backend API/error middleware is introduced in its requested roadmap step. The CLI verification is evidence for the current tooling only and does not mark that future HTTP check as passed.
