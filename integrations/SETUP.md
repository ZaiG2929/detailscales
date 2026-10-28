# Onboarding: Supabase, Slack and Google Sheets setup

The onboarding page at `onboarding.detailscales.com` collects three things from a new client, with no Jotform:

| Step | What the client does | Where it goes |
|---|---|---|
| 2. Your shop | Answers 55 onboarding questions | Supabase, Slack, master sheet (**Onboarding** tab) |
| 3. Your voice | Records the script in the browser, or uploads a voice memo | Supabase storage, Slack (with a Listen button), master sheet (**Voice** tab) |
| 4. Your list | Uploads contact files (phone exports, CSV, photos) | Supabase storage, contacts read into Supabase, **their own Google Sheet**, Slack, master sheet (**Contacts** tab) |

The client's email ties all three together. Everything is saved to Supabase first, so a Slack or Sheets hiccup never loses a submission. Failures are written onto the row in a `delivery_errors` column.

Setup takes about 20 minutes, once. Do the steps in order.

---

## 1. Supabase (the database), about 5 minutes

1. Use an existing project or create one at [supabase.com](https://supabase.com) (free plan is fine).
2. Open **SQL Editor → New query** (`https://supabase.com/dashboard/project/<project-ref>/sql/new`), paste everything from [`supabase-schema.sql`](supabase-schema.sql), and click **Run**. You should see "Success. No rows returned".
3. Open **Project Settings → API Keys** and copy the **secret** key (`sb_secret_...`). Projects that still show the legacy keys can use the **service_role** key instead; the code accepts either. **This key is a master password. Only paste it into Vercel, never into the page or Slack.**
4. The Project URL is `https://<project-ref>.supabase.co`.

## 2. Slack (the alerts), about 2 minutes

1. Create the channel, for example `#onboarding`.
2. Open this pre-filled app link: [create the DetailScales Onboarding Slack app](https://api.slack.com/apps?new_app=1&manifest_json=%7B%22display_information%22%3A%7B%22name%22%3A%22DetailScales%20Onboarding%22%2C%22description%22%3A%22Posts%20new%20client%20onboarding%20answers%2C%20voice%20recordings%20and%20contact%20uploads.%22%2C%22background_color%22%3A%22%2314161b%22%7D%2C%22features%22%3A%7B%22bot_user%22%3A%7B%22display_name%22%3A%22DetailScales%20Onboarding%22%2C%22always_online%22%3Afalse%7D%7D%2C%22oauth_config%22%3A%7B%22scopes%22%3A%7B%22bot%22%3A%5B%22incoming-webhook%22%5D%7D%7D%2C%22settings%22%3A%7B%22org_deploy_enabled%22%3Afalse%2C%22socket_mode_enabled%22%3Afalse%2C%22token_rotation_enabled%22%3Afalse%7D%7D) → pick your workspace → **Next → Create**.
3. Click **Install to Workspace**, choose `#onboarding`, and **Allow**.
4. Open **Incoming Webhooks** in the left menu and copy the **Webhook URL** (starts with `https://hooks.slack.com/services/`).

## 3. Google Sheets (master sheet + one sheet per client), about 7 minutes

1. Create a blank Google Sheet called `DetailScales Onboarding`. This is the master sheet.
2. In it, open **Extensions → Apps Script**. Delete what's there and paste everything from [`google-apps-script.gs`](google-apps-script.gs).
3. Near the top, replace `paste-the-same-long-random-secret-you-put-in-vercel` with a long random string (30+ characters; a password manager's generator is perfect). Keep a copy, you need it in step 4.
4. Click **Save**. In the function dropdown pick **setup**, click **Run**, and approve the permissions it asks for (Google will warn the app is unverified because you wrote it; click **Advanced → Go to … (unsafe)**). This creates the tabs and a Drive folder called **DetailScales client contacts**.
5. Click **Deploy → New deployment**. Gear icon → **Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

"Anyone" only means the URL can be called. Without the secret, the script refuses every request.

## 4. Vercel (switch it on), about 3 minutes

In Vercel, open the **detailscales** project → **Settings → Environment Variables**, and add these five for **Production** (and Preview if you want to test on preview links):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from step 1 |
| `SLACK_WEBHOOK_URL` | Webhook URL from step 2 |
| `SHEETS_WEBHOOK_URL` | Web app URL from step 3 |
| `SHEETS_SECRET` | The same secret you put in the Apps Script |

Then go to **Deployments**, open the latest production deployment's **⋯** menu, and click **Redeploy** so the functions pick the variables up.

## 5. Test it, about 3 minutes

1. Open `https://onboarding.detailscales.com` in a private window.
2. Step 2: fill the starred questions with test details and send. A message should land in `#onboarding`, and a row in the **Onboarding** tab.
3. Step 3: record a few seconds, tick the permission box, send. Slack gets a **Listen** button.
4. Step 4: upload a `.vcf` or `.csv`. Slack shows the contact count and an **Open their contacts sheet** button. The new sheet sits in the **DetailScales client contacts** Drive folder.
5. Delete the test rows from the sheet and from Supabase (**Table Editor**) afterwards.

---

## Good to know

- **Until step 4 is done**, the forms show "Sending is not switched on yet" and keep the client's answers saved in their browser. Nothing is lost.
- **Supabase free plan pauses a project after a week without activity.** A Vercel cron calls `/api/keepalive` every morning to prevent that.
- **Free plan room:** 500 MB database and 1 GB file storage. A one-minute recording is about 0.5 to 1 MB, so this covers hundreds of clients. Single uploads are capped at 45 MB.
- **Links in Slack and the sheets** (recordings, uploaded files) are private signed links that work for one year. The files themselves stay in Supabase **Storage** for as long as you keep them.
- **What gets read automatically:** `.vcf` (iPhone and Android exports) and `.csv`/`.txt` (Google Contacts, booking apps, spreadsheets saved as CSV). Photos, PDFs and Excel files are stored and linked in the client's sheet under **Files** for someone to type up.
- **If the Apps Script code changes,** paste the new version, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.
