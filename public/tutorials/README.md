# Tutorial videos

Phone-size how-to videos (780×1688, no sound, captions on screen). Recorded on
the Standard with features look, with "Parking Ops" as the company and "NAME" for
every person. Swipe is not shown.

| Video | Length | For |
|---|---|---|
| `1-owner-every-option.mp4` | 3:19 | Owner: the board, bottom bar, Returns, Stats, Summary and every Menu option |
| `2-terminal-setup.mp4` | 0:58 | Terminal: personal link, PIN, add to Home Screen |
| `3-terminal-picks-and-pt.mp4` | 1:39 | Terminal: COLL, NO SHOW, RTC and PT photos |
| `4-terminal-drops.mp4` | 1:38 | Terminal: CLEAR, undo, TO DO / ALL, search, notes |
| `5-bongo-setup.mp4` | 0:58 | Bongo: personal link, PIN, add to Home Screen |
| `6-bongo-picks-and-pt.mp4` | 1:31 | Bongo: picks board and PT photos |
| `7-bongo-drops.mp4` | 1:38 | Bongo: SENT, undo, search, notes |

Played in the app from Menu → Tutorials: terminal staff see 2–4, bongo drivers 5–7, everyone else all 7. The service worker leaves them alone (no offline copy). To add one, put the MP4 here with a still `.jpg` of the same name (`ffmpeg -ss 1.2 -i X.mp4 -frames:v 1 -vf scale=390:-2 X.jpg`) and add it to `TUTORIALS` in `app.js`.
