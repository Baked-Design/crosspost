# Crosspost: X to LinkedIn

Post on x.com like normal. Once X confirms the post went out, a small preview pops up bottom-right and it goes to LinkedIn (after a countdown, on your click, or instantly, your choice).

## Setup (~10 min, one time)

### 1. Load the extension
1. Unzip the release somewhere permanent (e.g. `~/Tools/crosspost`).
2. Go to `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.
4. The settings page opens. Copy the **redirect URL** shown at the top.

### 2. Create a LinkedIn app
1. Go to https://www.linkedin.com/developers/apps and click **Create app**.
2. Name it anything (e.g. "My Crosspost"). LinkedIn requires every developer app to be tied to a LinkedIn Company Page: use your company's page, or create a simple one first. Add any logo.
3. On the **Products** tab, request both of these (they're instant, self-serve):
   - **Share on LinkedIn**
   - **Sign In with LinkedIn using OpenID Connect**
4. On the **Auth** tab:
   - Under **Authorized redirect URLs**, add the redirect URL from step 1.4.
   - Copy the **Client ID** and **Primary Client Secret**.

### 3. Connect
1. Paste the Client ID and Secret into the extension settings.
2. Click **Connect LinkedIn** and approve.
3. Post something on X. Done.

## Extension ID is pinned (v1.2+)
The extension ID is now fixed: `ilmenogijpdgmjfkcfjehfihlbekmhgj`, so the redirect URL is always
`https://ilmenogijpdgmjfkcfjehfihlbekmhgj.chromiumapp.org/`
It no longer changes when you move or re-unzip the folder. Future updates: unzip over the old folder, hit reload in `chrome://extensions`, refresh X tabs. No re-setup.

## How it behaves
- **Triggers off X's own "post created" response**, so it only fires once X actually published the post, and it knows for sure whether it was a reply, quote or thread part.
- **Threads** get merged into one LinkedIn post.
- **Images** carry over (up to 9). Video and GIFs don't; the text still posts.
- **Replies and quote posts** are skipped by default (toggle in settings).
- **X-only marker:** set something like `#xonly` in settings, and any post containing it stays on X.
- **Hashtags** turn into real clickable LinkedIn hashtags.
- **Preview toast:** edit the text, hit Skip, or let it post. Clicking into the text pauses the countdown.
- **Recent** in settings shows what went out, with links.

## LinkedIn button on your posts
Every post of yours on x.com (profile, timeline, post pages) gets a small LinkedIn icon in its action bar. Click it to preview, edit, then **Post** or **Queue**. It turns into a check once posted and a clock when scheduled.

## Focus mode (v1.5)
Click the extension icon. You see one post at a time, your best unposted one first.
- **Q** queue it into the next open slot (the button shows exactly when, like "Tomorrow 9:14am") · **S** skip · **E** edit with the LinkedIn preview · **← →** browse
- **⌘K** (or /) search posts and run anything: import, schedule, settings, browse all posts
- **1 / 2 / 3 / 4** Review / Queue / Calendar / Posted. The icon bar at the bottom does the same.
- **Calendar:** month view of posted, scheduled and suggested posts, with a weekly count against your target. Empty slots get a suggested post from your imports; click + to schedule it.
- **Queue:** open slots show a suggested post too. Add, Edit, or × for a different suggestion. Every queued post has **Move** (next open slot, or pick a time) and **Unqueue** (it goes back to Review). Drag a post onto another slot to move it, or onto another post to swap them.
- **Calendar drag:** drag a scheduled post onto another day (keeps its time), an open slot, or another post (swap).
- The top line shows your week: week of the 12-week run, posts this week, how far the queue covers you.

## Smart suggestions (v1.8)
Review, Queue and Calendar only suggest posts that fit LinkedIn. Personal stuff (good morning posts, photos from home, car day, shout-outs, replies) stays out.
- **Quick fit check:** every post gets a score from its words, length, numbers, mentions and whether it's a reply. Work posts go first, personal ones are hidden.
- **Claude screen (optional):** if you added an Anthropic key, unclear posts get a second opinion from Claude in the background. Run it on everything from ⌘K: "Screen posts with Claude".
- **Teach it:** press **P** (or the Personal button) in Review, or **×** on a suggested slot, to mark a post not for LinkedIn. Undo from the toast. Mark it back from the Library row.
- **Topics:** in Settings > Suggestions, list what you post about (e.g. design, pricing, clients). Posts on those topics rank higher.
- **Live posts:** when a new X post looks personal, the pop-up asks before posting. You can set it to always skip or always post.
- **Library** hides personal posts by default. Untick "Hide personal posts" in the filter to see them.

## Dashboard (old posts + scheduler)
Click the extension icon to open it.
- **Import from X** opens your profile and auto-scrolls to save your posts (hit Stop anytime). Your posts also get saved in the background whenever you browse X.
- X only loads roughly your last 3,200 posts by scrolling. For older ones, download your X archive and use **Import archive** with `data/tweets.js`.
- Sort by most liked or most viewed to find your best old posts. Threads are merged automatically.
- Click a post to edit the LinkedIn version, rewrite with Claude, then **Post now**, **Add to queue** (next free slot) or **Schedule** a specific time.
- Select several posts and **Add to queue** to fill your slots in one go.
- **Queue tab → Schedule:** pick your days, how many posts a day (1 to 4) and your time windows, like `09:00-11:00, 20:00-23:00`. A window posts once at a natural minute inside it (9:17, 8:23pm). A single time like `21:05` posts exactly then.
- Scheduled posts go out while Chrome is open. If Chrome was closed at the scheduled time, they go out one a minute when it opens again. You get a notification either way.

## Visuals on LinkedIn (v1.3)
Every post can go out with a visual, since a text-only post gets 2 lines in the feed.
- **Tweet card:** a clean 1080x1350 screenshot-style image of your post (your avatar, name, badge, text, date, and the first image if there is one). Light or dark in Settings.
- **Post images:** your X post's own photos.
- **Text only.**
Default is the post as it is: its own images if it has them, otherwise text only. The tweet card is opt-in. You can switch per post in the preview or the dashboard. Your name and avatar are picked up the first time you browse X with the extension on.

## Hook check (v1.3)
In the dashboard editor, quick checks run as you type: line 1 fits the mobile preview (70 characters), there's a two-line hook with a blank line after, line 1 is lived or has proof, it's specific, a visual is attached, and there are no em dashes.
**Check with Claude** runs the full "ChatGPT test" and suggests 3 openers built only from facts already in your post. Click one to swap it in.
**Use playbook style** in Settings resets the rewrite instructions to the playbook version (hook, sub-hook, wide spacing, never invent numbers).

## Rhythm (v1.3)
The Queue tab has a 12-week run tracker: posts this week vs your target, streak, a 12-week grid, and how far your queue covers you. Default: one post a day, Monday to Friday, somewhere between 9 and 11am. The weekly goal follows your schedule.

## Optional: Claude rewrite
Turn on **Rewrite with Claude** and paste an Anthropic API key (console.anthropic.com). It rewrites each post for LinkedIn using your instructions (default: your voice, no em dashes, @handles into names, threads merged). You still see the rewrite in the preview before it posts. If the rewrite fails, it falls back to the original text.

## Good to know
- The LinkedIn login lasts **60 days**. When it expires, the toast tells you and links to settings. One click on Reconnect fixes it.
- It works on desktop Chrome only. Posts from the X phone app won't crosspost.
- If X renames its internal API calls, detection might need a tweak. The list is at the top of `inject.js`.
- Your keys live only in Chrome's local extension storage on this machine.
