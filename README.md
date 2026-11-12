# Shop-OS Estimate Agent (Milestone II)

A public chat agent for Shop-OS, my powersports shop management app (https://shop21-zeta.vercel.app). It turns repair requests and work orders into priced draft estimates using tools over the shop's data, and asks a human before it saves anything.

## What changed since Milestone I

| | Milestone I | Milestone II |
|---|---|---|
| Planner | Rule-based (keyword rules) | LLM with function calling (DeepSeek `deepseek-chat`; any OpenAI-compatible model works) |
| Tools | search_inventory, check_stock, find_mechanic, calculate_estimate | Same four, plus **lookup_work_order** (reads real Shop-OS work orders) and **save_draft_estimate** (gated action) |
| Stop condition | Max 6 iterations | Max 10 tool calls and 12 model calls per message, 12 messages per chat |
| Human gate | None | Approve / Reject card showing the exact arguments before any save |
| Access | Private page | Public link, no login |
| Interface | Single trace page | A Shop-OS lookalike (same sidebar, dashboard, jobs, inventory, mechanics and settings pages) with the agent built into each job: open or create a work order with a suspected issue, talk it through, watch the live estimate update, approve the draft |

Expansion used for the rubric: **a second real tool** (`lookup_work_order`, which reads the work orders stored in Shop-OS), plus a gated write tool.

## Files

- `public/index.html` · the Shop-OS-style demo app with the agent built in
- `api/shop.js` · read-only shop data for the UI (jobs, parts, technicians, rates)
- `api/chat.js` · the serverless endpoint (Vercel function)
- `lib/agent.js` · the agent loop, caps, human gate, signed chat state, system prompt
- `lib/tools.js` · the six tools
- `lib/shopdata.js` · Shop-OS data: bundled snapshot, or read-only live API
- `eval/cases.json` · 13 test cases with known-good answers (5 edge or adversarial)
- `eval/run-eval.js` · the eval harness (pass@1 and pass^k)
- `test/offline-test.js` · loop, guard, gate and state-signing tests with a fake model (no key needed)
- `GOVERNANCE.md` · governance note
- `EVAL.md` · eval results (pass@1 vs pass^k) and failure analysis

## Deploy (PowerShell, about 5 minutes)

1. Get a DeepSeek API key at https://platform.deepseek.com. Keep only a few dollars of prepaid credit and no auto-recharge, so spam can't run up a bill.
2. Open PowerShell in this folder: `cd ~\shop-os\agent`
3. Deploy: `npx vercel@latest` and answer: set up and deploy **Y**, link to existing project **N**, name **shop-os-agent**, directory **./**, change settings **N**.
4. Add three env vars with `npx vercel@latest env add <NAME> production`: `LLM_API_KEY` (your key), `LLM_BASE_URL` = `https://api.deepseek.com`, `LLM_MODEL` = `deepseek-chat`.
5. Optional, live Shop-OS data instead of the snapshot: add `DATA_MODE` = `live`, `SHOP_OS_EMAIL` and `SHOP_OS_PASSWORD` (your demo owner login) the same way.
6. Ship it: `npx vercel@latest --prod`. The URL it prints (e.g. https://shop-os-agent.vercel.app) is your public link.
7. Test on your phone with Wi-Fi off. If Vercel asks you to log in, go to the project's Settings → Deployment Protection and turn Vercel Authentication off.

If the chat says the model call failed, check the function logs in Vercel. A "model not found" error means you should check `LLM_MODEL` is `deepseek-chat` and `LLM_BASE_URL` is `https://api.deepseek.com`, then redeploy.

## Run the evaluation

```powershell
cd ~\shop-os\agent
$env:LLM_API_KEY="your-key"; $env:LLM_BASE_URL="https://api.deepseek.com"; $env:LLM_MODEL="deepseek-chat"
node eval/run-eval.js
```

13 cases × 3 trials, about 15 to 25 minutes on a free-tier key (the harness spaces calls 6.5 s apart and waits out rate limits). Results go to `eval/results/` as a JSON file and a Markdown report with pass@1, pass^1 to pass^3, a per-case table, and every failed trial's prompt, tool calls and reply. Options: `--trials 5`, `--only C08,C11`, `--delay 4000`.

The harness pins data to the snapshot so expected answers stay fixed, and it **never approves** a gated action: when the agent asks for approval, the harness records the request and clicks Reject.

pass^k is the tau-bench estimator: for each case with c passes out of n trials, C(c,k)/C(n,k), averaged over cases. pass@1 is the average of c/n.

## Run locally

```powershell
$env:LLM_API_KEY="your-key"; $env:LLM_BASE_URL="https://api.deepseek.com"; $env:LLM_MODEL="deepseek-chat"; node dev-server.js     # http://localhost:3000
node test/offline-test.js                           # no key needed
```
