# Pitchprep

<img src="frontend/img/pitchprep-180.png" width="64" alt="Pitchprep logo">

**Know your investor before you pitch.** Type an investor's name, your startup and a few apps your customers use. Pitchprep researches the investor on the web, then Qloo shows which of their portfolio companies your customers already love, and what to open the meeting with.

![Pitchprep home page](docs/pitchprep-home.png)

**Try it:** https://pitchprep-seven.vercel.app · **Video:** https://youtu.be/U7iwdsSlQDg

## Judge in 60 seconds

1. Open the site and click **Jason Calacanis**, **Todd Boehly** or **Michael Abrams** under "See a finished brief in seconds". Each is a recorded real run that opens instantly. Deep link: `/?demo=boehly`.
2. Look at **Name these companies**: their portfolio, ranked by Qloo for your customers.
3. Look at **With and without Qloo**: what an LLM alone would name from the same research, and where Qloo actually ranks those picks.
4. Open **How this brief was made** at the bottom: every step and every Qloo call behind the brief.
5. To run it live, fill in the form with anyone. It takes about 30 seconds.

## What you get

![A finished brief for Todd Boehly](docs/pitchprep-brief.png)

Every section carries a label saying where it came from:

| Label | Means |
|---|---|
| `Web` | Public web research. Every fact links to a source in the Sources list |
| `Qloo` | Computed from Qloo's taste data. The calls are listed at the bottom of the brief |
| `Interpretation` | Written by the model from the facts above |

## Where Qloo comes in

```
your comparable apps ──┐
                       ├─► Qloo ──► each portfolio company scored for your customers
their portfolio ───────┘            the two crowds' ages compared
their public interests ──► Qloo ──► what fans of those interests also love (openers)
```

| Step | Qloo call |
|---|---|
| Find the companies, interests and your comparables | `GET /search?query=…&types=urn:entity:brand` (also podcast, book, artist, tv_show) |
| Score their portfolio for your customers | `GET /v2/insights?filter.type=urn:entity:brand&signal.interests.entities=<your comparables>&filter.results.entities=<their portfolio>` |
| Compare the two crowds' ages | `GET /v2/insights?filter.type=urn:demographics&signal.interests.entities=<both sets>` |
| Find openers | `GET /v2/insights?filter.type=urn:entity:book\|podcast\|brand&signal.interests.entities=<their public interests>` |

The **fit score** is plain arithmetic, shown under the ranking: half your customers' mean affinity for the portfolio, half how alike the two crowds' age profiles are (cosine similarity).

### Without Qloo, the brief gets the companies wrong

Pitchprep asks the same question twice: once with Qloo, and once with only the web research. In the recorded Boehly run:

| Rank | With Qloo | An LLM alone |
|---|---|---|
| 1 | Chelsea F.C. (affinity 0.79) | Gopuff (Qloo #5 of 7) |
| 2 | Los Angeles Dodgers (0.78) | Cloud9 (Qloo #6 of 7) |
| 3 | A24 (0.77) | Overtime (Qloo #7 of 7) |

The LLM sees the same research. Only Qloo knows what your customers like.

## Responsible by design

- **Public, professional information only.** The research prompt rules out family, homes, health, finances and anything private.
- **The investor's name is never sent to Qloo.** Only their portfolio companies, their public interests and your comparables are. A test checks this.
- **Affinities describe crowds, not people.** Openers say "fans of X also love Y", never "the investor loves Y".
- **Unverified names are flagged.** Any company or opener the model cites that Qloo did not return is marked "not from Qloo".

## How the code is laid out

```
frontend/      what the browser loads: plain HTML, CSS and JavaScript, plus the images. No build step.
backend/
  server.js    a Node 22 HTTP server with no framework. It serves frontend/ and the API, and holds every key.
  lib/         where the work happens:
    pitch.js      the pipeline: research the investor, score their portfolio with Qloo, write the brief, then ask an LLM alone for comparison
    qloo.js       a small Qloo client that logs every call for the page
    llm.js        the OpenRouter client, including web search with citations
    demos.js      replays the recorded briefs in backend/data/demos
    limits.js     per-visitor and daily limits
    http.js       fetch with timeouts, and key redaction in error messages
  data/        the recorded example runs
test/          node --test, against fake Qloo and LLM services, so no keys are needed
api/           the Vercel entry point: one function that hands every request to backend/server.js
```

The pages in `frontend/`:

- `pitch.html, pitch.js, pitch.css`: the form and the brief

The browser only ever talks to this server. Qloo and the model are called from `backend/`, so no key reaches the page, and anything that costs money has a per-visitor limit (`backend/lib/limits.js`).

## Run it yourself

There are no dependencies to install. With Node 22 or newer:

```bash
npm start
```

Then open http://localhost:3302. The recorded examples work with no keys at all. For live runs, put these in a `.env` file next to `package.json`:

- `QLOO_API_KEY`: Qloo, for scoring the portfolio and finding openers
- `OPENROUTER_API_KEY`: the web research and the brief (Claude Haiku 5.5 by default; `LLM_MODEL` changes it)

```bash
npm test
```

## Deploy

`vercel.json` sends every request to `api/index.js`, so `vercel deploy` is enough. Add the same keys as environment variables in the project settings. Any host that runs Node works too: `npm start` listens on `PORT` when it is set.

## Tests

Pitchprep's tests run against a fake Qloo and a fake LLM, so they need no keys:

```
✔ pitch: cited web research, Qloo portfolio scoring with filter.results.entities, grounded brief
✔ recorded examples replay without any API keys, and the pages load
```

The Pitchprep test ([`test/pitch.test.js`](test/pitch.test.js)) checks that:

- the research prompt forbids private information, and citations come through;
- your comparables become the Qloo signal and the portfolio becomes `filter.results.entities`;
- invented companies are flagged as not from Qloo;
- the "without Qloo" picks are placed in Qloo's ranking (or marked as missing);
- no Qloo call contains the investor's name;
- every Qloo call is listed for the page, and no API key ever reaches the browser.

## Known limitations

- Investors whose portfolio isn't in Qloo get no ranking. Michael Abrams' example shows this honestly.
- Web research can miss or misdate facts. Each one links to its source so you can check.
- Recorded examples were generated on 21 October 2026; a live run reflects today's web.
- Qloo affinity measures taste overlap, not whether the investor will say yes.


## License

MIT. Built for the Qloo Agentic Hackathon, October 2026.
