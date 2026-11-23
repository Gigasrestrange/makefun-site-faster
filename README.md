# makefun-site, faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Gigasrestrange/makefun-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Gigasrestrange/makefun-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)`, which returns the same output tree
byte for byte. `main.ts` is the driver (reads `/input/cases.json`, writes `/output/answers.json`).

What makes it faster: Markdown inline text is scanned by code unit and escaped in chunks instead of one regex call per
character; the block lexer dispatches on a line's first character; front matter is read without splitting the whole
file; template nodes carry pre-split paths and for-frames are light; includes that read only `site`, `tags` and
`recent` are rendered once per build. License: MIT.
