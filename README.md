# ClearBooks: bookkeeping for ClearBooks Tax & Payroll

Your own business books: Irish sole trader, euro only, not VAT registered. It's a static web app with no server, no database and no dependencies. It's built on double-entry accounting: every transaction is a balanced journal entry, money is stored as integer cents, and entries can't be edited or deleted, only reversed.

## What it does
| Area | Features |
|---|---|
| **Invoices** | Numbered INV-0001…, customer details, hours × rate, no VAT (the engine refuses VAT while you're not registered). Print or save as PDF, email draft, record payments, void, write off bad debts |
| **Purchases** | Paid now (from the bank) or as a bill to pay later. Categories mapped to Form 11. Equipment goes to fixed assets |
| **Bank** | CSV import from AIB, BOI, PTSB, Revolut and others (DD/MM/YYYY; already-imported lines are skipped). Auto-match. Resolve a line as a match, an invoice payment, a bill payment, a new purchase, or a category such as drawings or bank charges |
| **Reconcile** | Opening balance + cleared items = statement balance. Shows outstanding items. A reconciliation can only be finalised when the difference is €0.00 |
| **Reports** | Profit & loss, balance sheet, trial balance, account ledger. CSV and print |
| **Year end** | Checklist (reconciled, all lines matched, debtors, creditors, depreciation), depreciation posting, **lock the year** |
| **Form 11** | Extracts From Accounts [124–168] taken from the ledger (2025 line numbering), suggested add-backs (160/161/162/167), 12.5% wear & tear estimate. CSV and print |
| **VAT watch** | Turnover against the €42,500 services threshold, for the current and previous calendar year |

## Run and test locally
    npm test      # 30 tests: engine + invoices, bank, reconciliation, Form 11
    npm start     # http://localhost:3000

## Deploy (Vercel)
    vercel login          # one-time
    vercel deploy --prod  # from this folder

`vercel.json` sets security headers (CSP, nosniff, no-referrer). `.vercelignore` keeps the tests and docs off the server.

## Data storage (important)
Your data lives in your **browser's local storage**, on one device and in one browser. Nothing is sent to Vercel or anyone else. Clearing site data erases it, so use **Backup** regularly (keep the files for six years, in line with Revenue's record-keeping rules). Restoring a backup re-checks every entry before loading it.

## Not included yet
VAT registration mode (VAT on sales and purchases, VAT3), credit notes, recurring invoices, multi-device sync and login (next step: Supabase), payroll for employees.
