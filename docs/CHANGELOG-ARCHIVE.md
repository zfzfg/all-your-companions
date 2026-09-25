# Changelog archive

Upstream releases of grok-build-vscode (4.1.8 and earlier), from before this fork. Current releases are in [CHANGELOG.md](../CHANGELOG.md).

## 4.1.8 — 2026-09-05

**Opening a conversation no longer freezes the app when you have a lot of them.** One shortcut on the way *out* of an untouched conversation was doing two expensive things nobody asked for, and both got worse the more conversations you had on disk.

### Fixed

- **The window stops locking up when you open or switch conversations** ([#131](https://github.com/phuryn/grok-build-vscode/issues/131), [#133](https://github.com/phuryn/grok-build-vscode/issues/133)). Opening an existing conversation first leaves the untouched **New session** you were on, and leaving it rebuilt the entire history list by reading every conversation directory in the project, then started a second agent process purely to delete that one empty conversation. With 3000 conversations present the app stopped responding for most of a second on every open, and the cost grew with the store. The abandoned conversation is now announced on its own, and the delete reuses the process already attached to it — no directory walk at all, and no second process. Reported by @RudyParengal and @leriksen71LJR.

## 4.1.7 — 2026-09-05

**A new cloud machine offers to connect an agent straight away, and the composer's menus close each other.** Two visible papercuts, and two quieter fixes: the buttons of a sign-in started from Settings did nothing, and approving an Edit or a Rewind long after asking for it could discard work done in the meantime.

### Fixed

- **One menu at a time in the composer** ([#148](https://github.com/phuryn/grok-build-vscode/issues/148)). Opening Settings left the context-usage popover on screen underneath it, and the same held for every pair among the add, settings, context-usage and mode menus. Each now closes the others, and still closes on its own button. Reported by @HubKing.

- **A brand-new cloud machine shows "Connect an agent" without a refresh.** On the first look at a machine that had just been created, the panel offering the three agents was painted and then hidden again a moment later, leaving an empty page with the model picker locked until you reloaded. An account that is configured but signed out no longer counts as one that has answered the offer.

- **"Re-check connection" and "Cancel" do something in Settings.** Both buttons of an agent sign-in started from the settings page were dead, and said nothing when pressed. GitHub's Re-check happened to work, which made the difference impossible to spot.

- **Approving an Edit or a Rewind late no longer reverts newer work.** With the confirmation waiting on one device, you could start and finish another turn somewhere else; approving afterwards rewound that newer turn's files too. An approval is now refused if the conversation moved on while it waited.

## 4.1.6 — 2026-09-04

**Connect GitHub from anywhere, and clone by picking a repository.** Private repositories were out of reach on a cloud machine, because signing in needed a terminal that machine does not have. GitHub is now a connection with a home in Settings, and cloning starts from a list of your repositories instead of a URL you have to remember.

### Added

- **GitHub in Settings, beside the agents.** It says whether you are connected and as whom, connects, and signs out — which had no home at all before, so a machine handed on or a wrong account connected could not be undone from a browser. Connecting is two steps: choose how, then a code and a button that opens the sign-in page. A fine-grained token is offered as the advanced path, scoped to one repository rather than everything the account can reach.

- **Clone by choosing a repository.** One field: type to filter the repositories that account can see, or type any URL or `owner/repo`. Cloning is offered in Knowledge work too, not only Coding.

### Fixed

- **Claude Code now reaches Connected on Windows** ([#146](https://github.com/phuryn/grok-build-vscode/issues/146)). Its model-cache warm-up doubles as the credential check, and cleaning up a temporary directory afterwards could fail on Windows and take the whole check down with it — so a working account read as a broken one, on every attempt. Reported with a diagnosis that was essentially correct, by @zfzfg.

- **Code spans keep their asterisks** ([#143](https://github.com/phuryn/grok-build-vscode/issues/143)). `` `1*2` and `3*4` `` rendered as one italic run. Reported by @SimonEast.

- **More room to write** ([#144](https://github.com/phuryn/grok-build-vscode/issues/144)). The composer grows to ten lines instead of five — six on a phone, where the keyboard already owns half the screen — and a question's "Other" answer takes more than one line. Reported by @SimonEast.

- **A running search says what it is looking for** ([#145](https://github.com/phuryn/grok-build-vscode/issues/145)) rather than a bare "Searching". Reported by @padixa.

## 4.1.5 — 2026-09-03

**Deleting a conversation now deletes it.** The one you are looking at used to disappear and come straight back as an identical empty row, so it looked as though nothing had happened. Along with it: the small print in a message footer is readable on a phone, and the Delete button's label is white instead of near-black on red.

### Fixed

- **Deleting the conversation you have open removes it and moves you to the next one.** It used to be replaced immediately by a fresh empty conversation, which looked identical to the one just deleted — and because the new one sorted to the top, the list appeared to jump under your selection. You now land on the neighbouring row, and a new conversation is created only when the project has none left. If you had typed a follow-up while the agent was working, deleting no longer leaves the conversation behind as a row that returns.

- **Two identical “New session” rows stop appearing.** Creating a blank conversation now reuses an unused empty one in that project instead of adding a second, which is where the duplicates came from.

- **A machine that keeps losing its connection settles down instead of hammering.** Reconnect delay was reset the moment a socket opened, so a host that connected and immediately dropped retried once a second indefinitely. It now waits for a connection that lasted. Most visible on cloud machines, which lose their connection every time they suspend.

- **Two browser tabs can no longer end up in one conversation.** Deleting from one tab could move it onto the conversation another tab was already using, and returning from a disconnect could do the same — in both cases the next message went into somebody else's tab. Each tab now gets a conversation of its own.

- **A conversation that will not open says so in plain words** rather than repeating the agent's wording and an internal identifier.

### Readability

- **The Delete button's label is white.** It was near-black on red — about 2.3:1 against the darker reds light themes use, under the 4.5:1 needed to read comfortably.

- **The timestamp and icons under a message are legible on a phone.** They rested at 40% of an already-muted colour, which compounds to roughly 1.7:1; on touch there is no hover, so that faint state was the permanent one. The row is still quiet, just no longer twice-quietened. The copy icon also stopped reading darker than the time beside it.

## 4.1.4 — 2026-09-03

**A machine that could not settle, and an error message that blamed you for it.** One fix stops a host retrying a failed connection every second for ever; the other stops a conversation that simply would not open from reading like a fault in your installation.

### Fixed

- **A host that keeps losing its connection now backs off instead of hammering.** The retry delay was reset the moment a socket opened, which sounds right and is not: it meant the delay could only grow while connections FAILED, and never against one that connected and immediately dropped — which is the situation it exists for. A machine in that state retried once a second indefinitely. It now waits for a connection that actually lasted before treating the way as clear, so a flapping machine settles down while a healthy one still reconnects immediately. Most visible on cloud machines, which suspend when idle and lose their connection every time they do.

- **A conversation that will not open says so in plain words.** It used to answer with the agent's own wording and an internal identifier — “Failed to start Claude: Resource not found: 85730a78-9918-43d7-a6c6-91a058348d89” — for something that is often entirely ordinary: a conversation whose first message never finished recording. The message now names what may have happened and what to do about it, and deliberately claims nothing more, because that same signal is also raised when the agent simply did not finish starting.

## 4.1.3 — 2026-09-03

**Two ways a conversation could get stuck, both of them on the way out.** Deleting one you had just started could kill it instead, and on a cloud machine the app could insist somebody else was looking at it — on a machine nobody is ever sitting at.

### Fixed

- **Deleting a conversation you have not used yet no longer breaks it.** On Codex and Claude, starting a session and deleting it while open answered “Internal error” — and left that conversation permanently unable to send, so the failed delete was how it died. Both providers write a conversation down only once a turn has actually run, so there was nothing there to delete and the refusal was right; the damage was the host abandoning its own cleanup after hearing it. The row now goes either way, and “there was nothing there” is no longer reported to you as a failure of your system. Grok never showed this, because it removes a folder and a missing folder is harmless — that difference is what named the cause.

- **A conversation on a cloud machine is no longer “open in another tab or the VS Code view”.** There is no tab and no editor on a cloud machine, but the host still kept a pointer at whatever it had opened last and counted that pointer as a person. Once you moved elsewhere the conversation stayed locked to it for good, naming two surfaces that do not exist there. The giveaway was the missing button to take it back: that appears whenever a real second device holds a conversation, and there was no second device. A second phone or browser tab still protects a conversation, exactly as before.

## 4.1.2 — 2026-09-02

**Things that quietly did nothing now do something, or say why.** A click on a sleeping cloud machine, a Clone that vanished, a Hide that was never going to work, a project telling you to update software that was already current — four different silences, one release.

### Fixed

- **A click wakes a sleeping cloud machine.** Two things woke one: attaching a browser, and the connection dropping while you were marked present. Presence lapses while you READ — reading is not interacting — so if you came back to the page and clicked, nothing was going to wake anything, and the click bounced into silence. Refreshing cured it only because attaching is a wake trigger and clicking was not. A send that finds no machine now wakes it: the send is the strongest evidence there is that somebody wants it.

- **A control action that cannot be delivered says so.** Clone, Hide, rename, delete, new session and the rest were posted and, if the connection was between sockets, discarded without a word — no progress, no error, nothing. They now either reach your machine or tell you they did not, once, with nothing changed. They are deliberately not queued for later: a clone that lands minutes afterwards moves the tab of somebody who has since gone elsewhere.

- **A project's conversations stop accusing your installation of being out of date.** One project could show “Sessions need a newer Grok Build” on a host running the newest release; reloading did not help and opening the project cured it. The message was never a version check — it was an eight-second silence being turned into a claim about your software. Underneath were two real faults: on a page with a remembered conversation the request never left the browser at all, and a preview whose entries included a worktree was thrown away whole on the way back. Both are fixed, the request always gets an answer, and silence now reads as “couldn't load these” with a Retry.

- **“Hide project” is no longer offered where it cannot work.** On a phone or a cloud machine the menu item drew, posted, and was refused by the host in silence. It was gated on the capability for ADDING a project, which stopped meaning what it said once creating and cloning became things a browser could do. It now asks for the capability it actually needs, and confirms before it acts — the editor's rail always did, the chat rail did not.

- **Host names in error messages.** Four places said “open VS Code on that machine” for a host that may be Cursor, Antigravity, Grok Build Desktop, or a cloud machine with no editor anywhere near it.

## 4.1.1 — 2026-09-02

**A clone that lands where you are standing, and one icon scale you can read.** Cloning a private repository from a phone worked and then left the tab looking at the project it started from — the files were there, just not on the screen that had asked for them. And the icons on that screen came in several sizes depending on which panel they happened to belong to. Both are settled here, along with the rail's own small dishonesties.

### Fixed

- **A clone now enters the project for the tab that asked.** Cloning onto a cloud machine from a phone cloned the repository and put it in the rail, and then the file explorer was empty and New Session did nothing — two symptoms with one cause: a browser tab carries its own selected repository, and the clone only ever told the host. Creating a project had the identical defect and no report against it, because nobody had made one from a browser yet. A network change mid-clone no longer turns a successful clone into a reported failure, and a brand-new user's very first clone — the case with no project open at all — is no longer skipped by the guard meant to protect it.

- **The context donut did nothing in knowledge work,** which is the default mode. Hiding the technical breakdown there also skipped the two lines that open the popover, so clicking the number opened nothing at all: no usage, no Compact. The breakdown stays hidden in that mode on purpose — somebody writing a document is not asking what the tool definitions cost — and the popover opens.

- **Switching project no longer reports your message as failed.** Leaving a conversation on purpose — switching repository, starting a new session, opening a row in another project — cleared the same remembered identity that a genuine loss clears, so the app announced "1 queued action was not sent" for something you had just chosen to do. The text still returns to the composer; the sentence now says where it went instead of announcing a failure.

### Icons and spacing

- **Two scales, split by panel, instead of one scale and an outlier.** The file explorer's controls were 20px while the rail's were 12–13px on the same screen, which is what made the rail read as a lesser control. Chat chrome stays at 20; the rail, the row above the messages and the file panel meet at 16, all in the same 28px box, so nothing reflows. VS Code's sidebar rail is deliberately its own denser tier — a 24px box with a 14px glyph — because nothing sits beside it to disagree with. On touch every one of them is a 20px glyph in a 36px target.

- **The row above the messages was missed twice.** Three surfaces build that header with three different sets of ids, so scoping the first fix to one of them left the desktop app and the browser at 20px glyphs with a 2px gap. All three are sized now, per surface, with no JavaScript deciding it.

- **Two controls leave the row on touch rather than shrink:** the per-session pin, which the row's ⋯ menu already carries, and the "+" beside PROJECTS, where the full-width Add project under the list is the better target by every measure.

### The rail

- **"Add project" is visible without hovering it.** VS Code's default theme paints secondary buttons fully transparent and keeps them readable with a border this control does not draw, so the button existed only under the pointer.

- **Rail rows stopped blinking while the rail loads.** One boot rebuilds the rail a dozen times or more as each project's rows arrive, and the row under a stationary cursor lost its hover — fill and buttons both — for a frame on every one of them.

- **One action, one icon.** The rail's new-session button wore a "+" while the New button above the messages wore the square-pen; "+" now means only "add a project". That button also sits under the project list at full width, which is where it earns its keep when the list is short or empty.

- **Small things found on a phone.** "Signed in to GitHub. Clone again." became "Try to clone again" — you only ever see that sentence after a clone has failed. The Cloning button carries the same blinking dots every other progress indicator here uses. And slash-command rows were set in the editor's monospace font while the @-mention rows beside them used the UI font; a menu item is being read, not edited, so the two popovers now agree.

## 4.1.0 — 2026-09-01

**The browser stops being the lesser half.** Rewinding a message, connecting Claude Code, signing in to GitHub and cloning a private repository were all things you had to walk to a desk to do — which on a cloud machine means walking to a computer that does not exist. All four now work from a phone. And a conversation no longer belongs to whichever tab opened it first: the tab you are holding wins.

### From a browser

- **Rewind and Edit, from whichever screen you are driving.** They were gated to the desk on the assumption that a remote could not be trusted with them — but there is no desk on a cloud machine, so the feature was simply missing there. An unsent message now belongs to its conversation and comes back to the surface that asked for it: edit from a phone and the text arrives on the phone, not in a draft at a laptop nobody is sitting at. If you switch conversations while the rewind is still running, the message parks on the conversation it was written for and comes back the next time that conversation loads. Nothing is lost.

- **Claude Code connects from a browser.** It never could, because Claude's CLI does not print a device code and poll — it prints a link and waits for you to paste the result back. That is a different shape from Grok and Codex, and probing the wrong command is what kept it desk-only. The card now reads in the order you act: what you are about to do, the link that does it, then the field for what it gives back.

- **Sign in to GitHub, and clone a private repository.** A cloud machine could only ever clone public repositories, which is most of the promise missing for most people's code. The old fix button opened a terminal on the host — on a hosted machine that is a screen with nobody at it. Signing in now happens where you are: a link and a short code, the same shape as connecting an agent. We never handle the token; `gh` stores its own credential, and git is wired to use it before the flow reports success, because a sign-in that leaves cloning broken is worse than no sign-in at all.

- **When something genuinely cannot happen in a browser, it says so.** Installing the GitHub CLI needs elevation, so it stays a desk action — and rather than silently opening an invisible terminal, it tells you where to do it. On a cloud machine the message says the truth instead: `gh` ships with the image, so its absence is a broken machine, not a missing step.

### One conversation, several tabs

- **The tab you are holding wins.** A conversation used to belong to the tab that opened it for as long as that tab's connection lasted, and nothing ever expired — so a forgotten tab on a laptop could make a conversation unreachable from your phone, with a refusal that named "another tab" without being able to say which. Now an explicit ask takes it: tapping a session in the rail, picking one from history, or choosing Continue here. No timer, no idle threshold, nothing to configure.

- **A tab that loses a conversation is told what happened, once.** It keeps its transcript, its controls freeze, and one button takes the conversation back. Reconnecting after a network change does not count as asking, so a phone waking from your pocket cannot silently steal a conversation back from the screen in your hand.

### Fixed

- **Re-focusing a live conversation showed the wrong agent.** Joining from a phone a conversation the desk already held left the model picker and the chrome describing whatever was there before — and on a session whose models had not arrived yet, the same path threw and wiped the transcript to an error.

- **A machine that is waking now says so.** Opening a page for a sleeping cloud machine showed nothing at all while it came up, which reads as a broken link rather than a machine getting out of bed.

- **Knowledge work says where cloning went.** Clone from GitHub is a coding affordance and is absent in knowledge-work mode, where an absent thing explains nothing. The menu now says it is one setting away, and selecting the hint opens that setting.

- **A rewind while another rewind was still parked no longer replaces it.** Narrow to trigger, and fixed anyway: the outcome was a message you wrote disappearing from the transcript and the composer at once.

- **Cloud machines with no SVG decoder no longer die on a missing icon.** New machines carry the fix; existing ones are upgraded in place.

## 4.0.0 — 2026-08-31

**Cloud machines.** A hosted environment you reach from a browser, with Grok Build and the agents already on it — no laptop to leave running, nothing to install. This release is the one that makes connecting an agent there work end to end, because a cloud machine has no desk: there is no second screen to answer a dialog, no terminal to read, and no one sitting at it. Every fix below came out of using one for real.

### Connecting an agent

- **One dialog, not two implementations.** The sign-in used to report into the transcript's welcome card, which refuses to draw over a conversation — so on a machine with any history the code, the progress and the failure were invisible, and Settings had grown a second copy of the whole flow to work around it. There is now one renderer, in a dialog, and both places open it. Closing it puts you back exactly where you were.

- **A sign-in finishes the job.** Connecting an account proved the credential and then stopped: the model picker stayed empty and the card still offered to connect the agent you had just connected, until you reloaded the page. Signing in now does what the Providers "Check again" button has always done — start the conversation that was waiting for an agent, fill the picker, and put the card away.

- **The agents are named as products.** Grok Build by SpaceXAI, Codex by OpenAI, Claude Code by Anthropic — in Settings, in the sign-in dialog, and on the buttons, with each vendor's mark beside it. The heading used to say "Connect Grok" while the button under it said "Connect Grok Build", because there were two lists of names.

- **Step one of the Codex sign-in is a link again**, and the security warning OpenAI is about to show you is named in bold before you meet it. Signing out puts the next sign-in back at step one, instead of dropping you at the code with the setting still off.

- **Disconnecting says it is disconnecting.** A sign-out from a browser crosses the network, wakes a machine that may have gone to sleep, and runs the vendor's own CLI — ten to fifteen seconds during which the button said "Sign out" and nothing happened, so people clicked it again. It now reads "Disconnecting…" and refuses the second click.

### Cloud machines

- **The projects rail is there from the first frame.** It used to wait for the machine to answer before drawing, which on a machine that was asleep meant the pre-rail layout — no rail, no file explorer — was the whole screen until it woke. Measured at four seconds of waiting; now a third of a second. A linked laptop still waits, because its Grok Build may be older than the answer.

- **A machine that is asleep is not a machine that is broken.** Sleeping is what a cloud machine does when you stop typing, and it wakes on your next message — so the page no longer announces it as a fault while you are reading. If a message is waiting to send, it says so, calmly, and sends it when the machine comes back.

- **The empty conversation calls itself AFK Pilot Cloud** there, rather than naming an extension nobody installed.

### Fixed

- **"Could not restore this tab's previous conversation."** An empty conversation was remembered as worth restoring whenever anything at all had been drawn in the transcript — including the notice saying an account had signed out. The machine then cleared that empty conversation away, so the next refresh asked for something that no longer existed, drew the error, and armed itself to do it again. Refreshing made it worse; only "New session" escaped. A conversation now counts as empty when it has no turns in it, and a refused restore forgets what it was refused.

- **"Sessions need a newer Grok Build"** was not a version check at all — it was an eight-second timeout, latched for as long as the page stayed open. A machine that was waking, or busy signing an account out, got labelled as an old install and never asked again. Reconnecting now asks again.

- **Signing out cleans up after itself.** Each sign-out replaced its conversations and left the empty ones behind, so a few connect/disconnect cycles put untitled sessions in the rail that nobody could account for.

- **The slash menu starts where your text starts.** In a browser it was drawn against the outside edge of the composer rather than the centred text inside it, so it hung further to the left the wider the window — which made it look like it depended on zoom.

- **The code and the buttons in the sign-in dialog are centred** by construction rather than by arithmetic that happened to work at one font size.

## 3.19.8 — 2026-08-31

Almost everything here is about **cloud machines** — the hosted environment you reach from a browser — because that is where a week of real use found the gaps. At a desk, the one change you will notice is the model picker.

### Fixed — connecting an agent from a browser

- **A sign-in that did not survive a refresh.** Connect Grok, connect Codex, reload the page, and both accounts offered Connect again. Two things were wrong and both had to go: the sign-in verified the credential but never recorded the account as connected — only the Providers refresh and the Check button ever did that — and the refresh itself was withheld from remotes, which is right for a laptop that has a desk behind it and wrong for a cloud machine, where the browser is the only surface there is. Signing in now records what it proved, and a cloud machine can re-observe its own accounts.

- **A machine that went to sleep in the middle of a sign-in.** Start a connection on a phone, switch to the vendor's page to approve it, and nothing on the machine is talking any more — so it was allowed to pause, which killed the connection the CLI was waiting on. Codex approvals that "worked" produced no credential. A sign-in now counts as work for as long as it runs, including while the credential is being checked afterwards.

- **"Codex approved the sign-in, but no usable credential landed."** It had landed. The check that looks for it opens a throwaway session, reads the models, and deletes it — and Codex cannot delete a session that never wrote anything, so a working sign-in was declared a failure one step after it succeeded. Cleaning up can no longer fail the check that comes before it.

- **Connecting Codex is now two numbered steps, and the security warning is not a surprise.** Codex needs one setting turned on in your OpenAI account before any code is accepted, and OpenAI's page then warns — correctly — that device codes are used in phishing and to continue only if a CLI started the sign-in. Step 1 gets you to the setting, with the link and the exact place it hides. Step 2 shows the code beside a note saying that warning is coming, that this machine's Codex CLI is what started this, and never to use a code you did not start yourself.

- **Connecting from Settings looked like a button that did nothing.** The sign-in reported into the transcript's welcome card, which refuses to draw over a conversation — so on a machine with any history, the code, the progress and the failure were all invisible. Settings → Providers now shows the whole flow itself: the code, a Copy button, the sign-in link, and Cancel. Tapping Connect again while one is running repeats the current code to the tab you are holding instead of answering with silence.

- **Success is announced only when it is true.** The CLI exiting cleanly means the vendor approved; it does not mean this machine can use the account. "Connected" now waits for the credential to answer, and when it does not, the message says which of the two failed — a sign-in that never landed, or a sign-in that landed and needs another moment.

### Fixed — cloud machines

- **A machine being built is no longer reported as broken.** A brand-new environment can take up to twenty-five minutes to install from scratch, and the page called it a failure after ninety seconds — advising a reset for a machine that was working perfectly. It now explains at ninety seconds, blames only after twenty-five minutes, and shows progress in the calm blue of a notice rather than the red of an error. Reopening the page for a machine that has worked for days no longer mistakes it for a first boot.

- **Claude Code says so up front.** It cannot be connected on a cloud machine yet — its sign-in needs a terminal — so instead of a Connect button that always ends in a wall, the row and the start screen say we are working on adding it. Grok is marked as the recommended agent there, and a fresh machine offers all three rather than whichever one happened to be asked for.

- **Anonymous usage stats and Thumbs feedback can be changed.** Both were read-only on any remote. A cloud machine has no desk to change them from, so read-only meant never.

- **Settings stopped talking about "the desk"** on a machine that does not have one, and the tips stopped suggesting things a browser cannot do — dropping a file onto the composer works in the app's own window, not in a browser. The tip that suggests connecting a second agent now appears on remotes at all, which is where it matters most: on a cloud machine that is the only way to do it.

### Fixed

- **A newly connected agent appears in the model picker straight away.** Connect Codex from a conversation that already has messages in it and it was missing from the picker until you reloaded — the catalogue was refreshed only for conversations that had not started yet. A first-time agent is purely additive, so it now reaches the picker you are actually looking at.

- **"Update Grok Build to preview"** read as an instruction to install a version called "preview". The rail now says the sessions it cannot list need a newer Grok Build, and when the chat reports that a project folder is no longer open, it adds that the machine is running an older build — the two halves of the same fact, previously on opposite sides of the screen.

- **A sign-out that could not run now logs why.** The message said only that it "could not be observed"; the log now carries the path and the error, which is what the diagnosis actually needs.

## 3.19.7 — 2026-08-30

### Fixed

- **Less of the freeze when you have a lot of conversations.** Reported as a hard lock with a white title bar (#133, #131) and as session switching going wrong (#138). We reproduced it here rather than guessing: with 3000 conversations on disk the app's main thread — the one that paints the window — stopped responding for about a second at a time. The cause was not the agent being slow. A test that stalled the agent by three seconds left the window perfectly responsive; that is a spinner, not a freeze. It was us, walking your entire conversation folder to sort it by date, **up to four times for every click**, on the thread that draws the app — and nothing on screen changed as a result of any of those walks. Opening a conversation no longer rebuilds the list at all, because the set of conversations does not change when you open one, and the periodic tidy-up of abandoned empty conversations no longer runs on every click, because it ignores anything under 30 minutes old and so could never have found something a run half an hour earlier had missed. Measured on one machine at 3000 conversations, before and after, back to back: catalog walks over three conversation opens **from 11 down to 4**, total time the window spent unresponsive **roughly halved** (4.8s to 2.3s), and the worst single stall from about 1.1s to 0.8s. **This is an improvement, not a cure** — a stall you can still notice remains, one walk per open is still there, and the change that removes it is written down and waiting. If you have a large history, this release should feel better; please say so on #133 if it does not.

- **Dark High Contrast made the effort dots and the check mark invisible.** They were painted in VS Code's button colour, which that theme defines as pure black, so they vanished into the popover behind them (#139, thanks @HubKing). They now use the link colour, which every theme guarantees is readable as text. A test now enforces the rule across the whole UI, and it immediately found a third place with the same bug that nobody had reported: the settings toggle switch, which could have rendered "on" identically to "off".

- **One-word commands run in your shell too.** 3.19.6 unwrapped the agent's `bash -lc` wrapper only when the command inside was quoted — and the tool that builds those wrappers leaves anything simple unquoted. So `ls`, `pwd`, `make` and `pytest` kept the old path and stayed on macOS's bash 3.2, which is most of what anyone actually types (#140, thanks @russwyte). A bare command built only from characters no shell treats specially is now unwrapped too; anything with whitespace, a variable, a glob, a tilde, a pipe or a redirect still keeps the wrapper, because those are where the two readings could differ.

- **"Connect Codex" opened a terminal that could not start.** Installing Codex with npm leaves two files side by side: one for Git Bash and one for Windows. We were finding the Git Bash one first, and Windows cannot execute it at all — so the sign-in terminal failed to launch with nothing to click, and the same unusable path was handed to the agent process. We now look for the Windows one first, which is what the Grok CLI lookup has always done.

- **Connectors stop asking you to sign in again out of nowhere.** A connector whose stored credential has gone missing cannot refresh it, so the proxy starts a fresh sign-in and opens a browser — unprompted, on every new conversation, for ever, because nothing recorded that it failed. One connector in that state reads as the app demanding sign-ins at random. Those connectors are now left out until you reconnect them: the row says so and offers a Connect button, and no browser opens unless you press it. This is deliberately not about expiry — credentials expire every few hours by design and are renewed silently; only a credential that is actually gone counts.

### Fixed — cloud environments

- **Providers can be connected and disconnected from the page that lists them.** Settings → Providers was read-only for a remote, which was true when it was written and stopped being true when headless sign-in shipped — leaving the onboarding card as the only way to connect an agent from a phone or a cloud machine. Signing **out** now works too, but only on a cloud environment, where the remote is the machine's only surface: a credential you can grant and never revoke is the worse answer there. At a desk it stays local, because signing out revokes a credential every window on that machine shares.

- **The Codex sign-in card's own button did nothing.** The card that explains the one account setting Codex needs was shown unconditionally, so pressing "I've turned it on — connect" re-drew the same card. It could never be got past. The advice is still shown first — it saves a wait for a failure almost every account hits — but it is advice, not a gate, and the second attempt now runs for real. The step naming the setting also says **at the very bottom**, because that is where it is on the page.

- **A new machine no longer says it is broken while it is still starting.** Opening a cloud environment straight after creating or resetting it announced that it was not responding — a message written for a machine that went away, shown to one that had not arrived yet, which is the first thing a new user sees. Starting up and having gone offline are now separate states with separate words, and a first boot that genuinely never finishes still says so after 90 seconds rather than reassuring you for ever.

- **A provider that cannot be signed in from a cloud machine no longer tells you to go and do it at your computer.** There is no computer to walk to. It now says what does work there.

## 3.19.6 — 2026-08-30

### Fixed

- **Agent commands really do run in your own shell now.** 3.19.5 switched the shell on macOS and Linux and that was not enough: Grok sends every command already wrapped as `/bin/bash -lc …`, so running it under zsh just meant zsh handed it straight back to bash — the same bash 3.2 from 2007, sourcing the same profile, printing the same sdkman error. Verified against the real CLI: **every** command it issues arrives inside that wrapper. The wrapper is now unwrapped and the command is given to your shell as an explicit argument, so it cannot bounce back into bash — when that shell can stand in for bash (zsh, bash). On `/bin/sh`, dash or ksh the wrapper is deliberately left alone, because Grok wrote the script for bash and a smaller shell would fail on syntax it is entitled to use. A command the model itself wrote as `bash -lc …` is left alone. Found, diagnosed and fixed by **@russwyte** in #141 — including the part 3.19.5 missed. A `$SHELL` we cannot drive (fish, nushell) or that is not a runnable file still falls back to `/bin/sh`. **If a project's `.env` sets `SHELL`,** the agent reads that while your commands still run under the shell VS Code itself was started with — so bash-only syntax could now fail where it previously worked. Rare, and on the list to fix. **One behaviour change worth knowing:** that wrapper was also making every command run through a *login* shell, so your profile was being sourced. It no longer is. If a tool is on a `PATH` that only `~/.zprofile` or `~/.bash_profile` sets, the agent may stop finding it — tell us if that happens to you, it is the kind of trade-off worth revisiting with real cases.

## 3.19.5 — 2026-08-30

### Fixed

- **Agent commands run in your own shell on macOS and Linux.** Every command the agent ran went through `/bin/sh`, which on macOS is bash 3.2 from 2007 — not the shell you actually use. Anything that branches on which shell is running took the wrong branch: sdkman printed a `bad substitution` error at the top of every command's output, because seeing bash 3.2 sends it down a path that needs bash 4. Commands now run under the shell `$SHELL` names, when it is one the agent can drive (sh, bash, zsh, ksh, dash, ash), and fall back to `/bin/sh` otherwise. That also lines the two halves up: the agent decides which dialect to write from `$SHELL`, so running the shell `$SHELL` names means the shell it describes and the shell it gets are the same one. **This changes which shell runs your command, not what your profile sets up:** as before, commands are not run through a login shell, so `~/.zshrc` and `~/.bash_profile` are still not read and a tool that only exists on a `PATH` set there is still not found. Setting **Terminal shell** to `cmd` forces `/bin/sh` exactly as before, and Windows is unchanged. Thanks to @russwyte (#140), whose report named the cause precisely.

- **A slow conversation open now says where the time went.** The `session open:` line in the log listed phases that could add up to a small fraction of the time the open really took, with nothing admitting the gap — one report showed 5.2 seconds against 379ms of named work, and every phase on it looked fast. The line now accounts for its whole total: whatever the named phases do not claim is printed as `other`, and the clock starts when you click rather than partway through, so finding the conversation and reading its stored details are on the line too. That last part is not small — on a machine with a lot of history it was the largest single piece of the open, and it was invisible. Starting a new conversation is now timed too — in one reporter's log that step took between 2.2 and 4.8 seconds every single time, and nothing on the line said so. Chasing #131, #133 and #138; if you have been hit by one of those, a fresh log now says considerably more.

## 3.19.4 — 2026-08-28

### Added

- **The file panel can be told to look again.** It read each folder once and kept that listing for as long as the project stayed open, so anything changing files behind its back — the agent writing them, a build, a branch switch, another editor — left it quietly wrong with no way to ask for a fresh look. There is now a **Refresh** control in the panel header, **Refresh this folder** on a folder's right-click menu, and the same button inside an empty folder, which is where it is easiest to conclude the panel is simply broken. Refreshing keeps your place: folders you had open stay open, and your filter text, scroll position and open file tabs all survive. Thanks to @leriksen71LJR (#134).

### Fixed

- **A folder too big to list in full appeared to be empty.** Past the listing cap, the "Folder truncated" note replaced the very entries it was meant to sit under, so a large folder showed the warning and none of its files. The note now sits below them.

## 3.19.3 — 2026-08-28

### Fixed

- **The desktop app writes its log again.** 3.19.2 added a log file so anyone chasing a problem would have something to send, and the code that started it could not run — the app threw on every launch before writing a line, so the release whose whole purpose was to produce logs produced none. It writes from the first line now, and rotation measures what it actually wrote rather than guessing at startup, so a long session no longer grows one file without end. Still under **Settings → Advanced → Show logs**.
- **A long turn survives you putting your phone down.** On a cloud environment the machine is suspended when nothing has touched it for about a minute, and suspended means frozen — so a turn that spent four minutes running tests or an install was stopped in the middle of the work you had walked away from. That is the one thing remote control exists to prevent. The machine now says it is still working while the agent is working and for as long as any command it started is still running, however long that takes; if it stops to ask you something and you do not come back, it goes to sleep after twenty minutes and wakes when you open the page, with the question still there. **Nothing changes on your own computer**, where the wake lock already covered this.

### Changed

- **A new install no longer files your work under the name of the tool.** New projects went into `~/Grok Build`, and on the desktop app that folder was also your first project — the product's name on a folder that is yours. New installs now get an **AFK Pilot** folder holding a first project called **My First Project**, so the container and the project are no longer the same thing. If you already have a `~/Grok Build` folder it keeps being used and nothing moves; that decision is made once and remembered, so an upgrade never scatters your projects across two roots. In a cloud environment the welcome screen now reads **AFK Pilot (Cloud)**, which is the product you are actually in.

## 3.19.2 — 2026-08-27

### Fixed

- **You can get the logs off the desktop app.** *Settings → Advanced → Show logs* did nothing: it was wired to an empty function, DevTools is disabled in packaged builds, and the log went to stdout — which is discarded when the app starts from an icon rather than a terminal. Anyone asked for a log went looking and correctly found none. The app now writes a log file under its own data folder, keeps one previous copy, and **Show logs** opens the folder with it selected. Lines are written as they happen, so the ones just before a freeze survive. Reported while chasing #131 and #133 by @RudyParengal, who was right that the button did nothing.
- **A proposed-change diff you closed stays closed.** Returning to a conversation reopened the `Grok proposed:` tab and pushed the files you were working in off the screen. Auto-open now happens once when the change is proposed, not every time the conversation is redrawn — a new edit still opens, and **open diff** reopens it whenever you want. Thanks to @tarekmaalouf (#132) for pinning down exactly what was happening.

## 3.19.1 — 2026-08-27

### Fixed

- **Cloud environments can start.** The Linux build published in 3.19.0 could install itself on a hosted machine and then never come up: a packaged build refuses to take its relay or its device token from the environment, which is right for an app on your desk and impossible for a machine with no keyboard. That one build is now marked as a cloud build at package time and accepts an identity only when the machine also declares itself a cloud environment. **Nothing changes for the Mac and Windows apps** — they still refuse the environment exactly as before, and the Linux AppImage remains a cloud-only artifact rather than a desktop download.

## 3.19.0 — 2026-08-27

### Added

- **Connect an agent from your phone.** The remote empty state used to say sign-in could only happen at your computer, and stop there — true of how it worked, and a dead end at the moment you most wanted a next step. Pressing **Connect** from a phone or browser now runs the agent CLI's headless sign-in and shows you the link and the short code it prints; you confirm it in your own browser and the page finishes on its own. The credential still lands on the computer running the extension, the same as before — nothing is kept in the browser and the relay never sees it. **Nothing changes at your computer**, where Connect still opens a terminal, because there the CLI opens your browser for you. Grok works this way today; Codex needs both a recent CLI and "Allow device code login" enabled on the account; **Claude has to be connected at your computer**, because its sign-in is a terminal interface that prints nothing when it is not attached to one. The app finds this out by asking the CLI rather than by checking a version, so an agent that gains the ability starts working without an update here. Signing *out* stays at your computer. See [Signing agents in](https://github.com/phuryn/grok-build-vscode/blob/main/docs/provider-login.md).

## 3.18.0 — 2026-08-26

### Added

- **Add project can make one, not just find one.** It used to be a single control that opened your operating system's folder picker — right for a folder that already exists, and wrong for everything else. There are three ways in now. **New project** takes a name and creates `~/Grok Build/<name>`: one folder, no `git init`, and nothing to choose in a file dialog. **Import a folder** is the picker, unchanged. **Clone from GitHub** takes a repository URL and checks it out beside the others; it appears in Coding mode, because that is where it belongs. A host that offers only one of the three shows no menu at all.
- **Naming a project and cloning one work from your phone.** They send a name or a URL and let the computer running the extension decide where it goes, which is why they can travel when the folder picker never could — a native dialog is not something a browser can show or answer. Importing stays at the desk for that reason.
- **Cloning uses the Git credentials you already have.** No token to paste, nothing stored, and public repositories need nothing at all — on most machines the GitHub CLI is never needed at all. When a private repository does fail, the form says so and offers the next step rather than printing what Git said. **Sign in to GitHub** runs `gh auth login` *and* `gh auth setup-git`, because login alone asks whether to configure Git and lets you say no — which would leave the clone failing exactly as before. If the CLI is not installed, the button offers to install it and names the exact command first; if there is no package manager to install it with either — a Mac without Homebrew, Windows without winget — it points at cli.github.com rather than offering a button that would run a command which is also missing.
- **A tip on the empty screen.** Once an agent is connected the welcome screen had nothing to say; it now carries one quiet line naming something you have not set up yet — another agent, a routine, connectors, read aloud, `@` file mentions, a worktree. Each links to the exact place it names. You are never shown advice about something you have already done, no tip appears twice in a day, and **✕** means *not today* rather than never. When it all applies to you, the line is simply gone. See [Tips on the empty screen](https://github.com/phuryn/grok-build-vscode/blob/main/docs/empty-state-tips.md).

### Fixed

- **The Settings link on a tip opens the right page.** Every tip that points at Settings now lands on its own category rather than the top of the page.

### Documentation

- [Projects](https://github.com/phuryn/grok-build-vscode/blob/main/docs/projects.md) — the three ways to add one, where new folders go, name rules, and what happens when a clone needs credentials.
- [Signing agents in](https://github.com/phuryn/grok-build-vscode/blob/main/docs/provider-login.md) — how Grok, Codex and Claude authenticate, including the headless paths for a machine you only ever reach remotely.
- [Tips on the empty screen](https://github.com/phuryn/grok-build-vscode/blob/main/docs/empty-state-tips.md) — what can be suggested, the rules it follows, and where the state lives.

## 3.17.2 — 2026-08-25

### Fixed

- **The routine model picker lists each agent once.** It was showing every provider twice — three headings holding a single "use this agent's default" row, then three more holding the real models. The default row is now offered only where it means something: when an agent has no other model to show yet, or when a routine is already set to it. New routines start on a real model, the way the composer does.

## 3.17.1 — 2026-08-25

### Fixed

- **Routines now load in the VS Code Settings tab.** Opening Settings as a tab (rather than through the chat panel) left the Routines page saying "Loading routines…" and never finishing. The tab listens for its own updates and had never been told about routines, so the answer arrived and was dropped. The chat panel and the desktop app were unaffected.

## 3.17.0 — 2026-08-24

### Added

- **Routines.** A prompt, a project, a model, and a cadence — saved once and run on a schedule. Settings → Routines. Each firing opens its own session named after the routine (`[Routine] Morning brief`), so the answer is waiting in the rail rather than needing you to be there when it arrives. The last twenty runs are kept per routine, as a strip you can read at a glance: a run that worked opens its session, one that was skipped says which model was missing, one that failed says why. A daily cadence takes a time of day and holds it through daylight saving; anything shorter runs at most once every fifteen minutes. Routines run while any Grok window is open — this extension, or the desktop app — and nothing runs once they are all closed, which the page says rather than leaving you to discover. On a phone you can create, edit, pause and remove them for any project that phone can already reach.
- **Zapier connector.** Reaches whatever apps you have added to your own Zapier MCP server — Gmail, Calendar, Slack and thousands more. Sign in through the browser like the other connectors; there is nothing to paste. Build the server and pick its apps in Zapier first, since one with no apps added exposes no tools.

### Fixed

- **A connector that fails to start now says what went wrong.** The report took the last line of the failure, and for anything Node itself throws that line is the version banner — so a broken install surfaced as `Could not connect: Node.js v20.19.0`, which named nothing. It now reports the error.
- **Every connector's "get a token" link pointed at GitHub.** The address came from the connector; the words next to it were hardcoded, so any connector but GitHub sent you to the wrong place.
- **Settings no longer jumps back to the top while you are using it.** Anything that refreshed the page — connecting a connector, saving a change — scrolled it to the beginning and moved the row out from under you.

## 3.16.0 — 2026-08-24

### Added

- **The waiting indicator says how long it has been waiting.** *Grokking* now carries a running count from the moment it appears — `Grokking · 4m 12s`. A turn has no deadline you can see (the extension tolerates 30 minutes of CLI silence before giving up, deliberately, so a long healthy turn is never killed as if it were stuck), which meant "working" and "wedged" looked identical. The count says nothing about whether anything is wrong, only how long the wait has lasted.

### Fixed

- **A slow network no longer holds up every session start.** The silent CLI update that runs once after an extension upgrade could block the composer for up to three minutes, and a failure left it to be retried on the *next* window — so where `x.ai` is unreachable, every new window paid that stall again, indefinitely. It now gets 20 seconds and one attempt per extension version. The update is optional; if it can't finish quickly the session starts on the CLI you already have. Thanks to [@funkpopo](https://github.com/funkpopo), whose measurements from a network that can't reach `x.ai` found this ([#129](https://github.com/phuryn/grok-build-vscode/pull/129)).
- **A local connector that reports no health status is no longer shown as unavailable.** Servers declared in your Grok config files often report that they are enabled without a health field, and only an explicit `ready` earned the green dot — so a working server looked exactly like a broken one, on a row with nothing to click. Thanks to [@funkpopo](https://github.com/funkpopo) ([#128](https://github.com/phuryn/grok-build-vscode/pull/128)).
- **A connector that recovered stops showing as failed.** A server's error message was never cleared once reported, so a connector that failed once kept that error for the rest of the session and its row stayed red even after it came back. A later status report now supersedes it. Connector status is also honest on the phone now: the error text deliberately stays on your machine (it can quote a launch command), but the fact of a failure travels, so a broken server no longer reads as ready there.
- **The Windows desktop installer builds again.** The telemetry identity added in 3.15.0 was passed to the packager as a bare argument, and PowerShell split it in two — so the Windows leg of the release failed while macOS succeeded, and v3.15.0 shipped without a `.exe` until it was rebuilt.

## 3.15.0 — 2026-08-23

### Added

- **A file read is now a link to the file, and clicking it shows you the file.** A `Read` row reads `Read chat.js lines 8400-8459`, with the path and range themselves clickable and no excerpt underneath — the six lines it used to print were the ones you could already see, and they cost the row the space the path needed ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)). In an editor the link opens the real file with those lines selected. In the desktop app it opens a preview showing the **whole file** with line numbers and the agent's lines marked in blue, scrolled to them — the surrounding context is the reason to click, and until now that surface showed only the excerpt. Both previews gained **Open in file panel**, beside Copy and Save As, for when a glance turns into reading.

### Fixed

- **Connectors stop asking you to sign in again when more than one window is open.** `mcp-remote` pins its sign-in port to the one recorded in its own registration, and on Windows it cannot see that another window already holds it. The extension answered that collision by retrying on a different port — which is `mcp-remote`'s signal to discard its registration and enrol afresh, so a browser tab opened, and because the credential store is shared, every other window was pushed into signing in too. One collision re-authorised the machine. The collision is now reported instead of worked around: it means the connector is already signed in and running, which is the good case.
- **Links to files under `~` open ([#125](https://github.com/phuryn/grok-build-vscode/issues/125)).** `~/Downloads/notes.md` was treated as a relative name and looked for inside the project, so clicking it said the file was missing. `~` is now expanded to your home directory. `~someone/…` is deliberately left alone — resolving another account's home needs more than a guess.
- **Reading a whole file no longer invents a line range.** A read with no offset or limit showed `lines 1-812`, which was not a range the agent chose but simply the length of the file. The row shows the path alone, and the link opens the file with nothing selected.
- **Expanded tool details appear while the agent is still working.** With *Expand tool details* on, a group settled its expansion only once the batch had finished, so reads and searches stayed collapsed until the end — commands too. They open as the rows arrive now.
- **The desktop app was reporting no usage data at all.** Packaging rewrote the app's name, so its identity check could never match and telemetry disabled itself silently — which is correct behaviour for a fork and wrong for our own app. Every figure we had was therefore "of editor users" without saying so.
- **Usage data stopped discarding editors it did not recognise.** The host name was checked against a fixed list of seven products, so anything else — Antigravity IDE, code-server, Kiro, Devin, Windsurf — was dropped on the floor rather than recorded. It is now validated for shape, the same way the model name always has been.

### Changed

- **The anonymous usage event records four more things**, all documented in [docs/privacy.md](privacy.md): which CLI the session runs on, how many connectors are set up on the machine, whether the session started in a git worktree, and whether this install has been seen before. Values only, never content — the CLI is one of three names, and the connector figure is a count, never the list.
- **`install.sh` and `release.sh` do what their PowerShell counterparts do.** The shell versions were about half the size, and the gaps were not cosmetic: `install.sh` could not build against a staging relay at all, `release.sh` skipped the screens gate, the wait for CI, the Open VSX publish and the local install, and was committed without its execute bit — so the command its own usage text documents could never have run. `install.sh --all` also found no editors on macOS, exited non-zero, and looked successful.

## 3.14.1 — 2026-08-22

### Fixed

- **Connectors stop asking you to sign in again.** `mcp-remote` stores its authorisation tokens in a folder named after its own version, and the extension was letting npm resolve whichever version was newest at the moment a session started — so every upstream release silently emptied your credentials and opened a browser tab for each connected service. Three versions shipped in twenty-four hours. The version is pinned now: the desktop app and the editors share one set of tokens, and changing it becomes a deliberate decision instead of a surprise.
- **View all on a Read row opens the file, not a copy of it ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)).** It opened an untitled document holding just the lines the agent had read; it now opens the real file with those lines selected.
- **A long-running conversation stops growing its stored cost ledger without limit.** One entry per turn was kept forever; past 400 turns the older ones now fold into a running total.

## 3.14.0 — 2026-08-21

### Added

- **Three more connectors, and connectors that take a key.** **GitHub**, **Calendly** and **Airtable** join Settings → Connectors. GitHub is the first that authorises with a personal access token you paste on the row itself (fine-grained recommended) rather than a browser round trip — the token goes to the platform secret store, never into `grok.mcpConnectors` and never into a settings file you might share. Connecting it in one editor now takes effect in the others instead of disconnecting them.
- **A long conversation opens in a fifth of a second ([#102](https://github.com/phuryn/grok-build-vscode/issues/102)).** Opening a conversation with hundreds of turns took the better part of a minute and left the panel unusable while it worked. It now renders the most recent turns first and fills in the rest as you scroll back: 46 seconds became 191 milliseconds on the conversation that prompted the report, and resizing the panel went from a quarter of a second to ten milliseconds.

### Fixed

- **A reconnect feels like nothing happened.** Switching apps on a phone, locking the screen, or losing signal all drop the socket, and the reconnect used to be loud: the conversation was torn down before its replacement existed, the welcome screen flashed over a chat that was still coming back, the title blanked, the composer stole focus, and "Starting" appeared over a conversation that was merely being restored. The conversation now stays on screen throughout, and the panel says *Restoring conversation* rather than pretending to start a new one.
- **Your place in the conversation survives a reconnect.** A reader scrolled up was yanked back to the bottom when the transcript was replayed — twice over, and from more than one direction. If you had scrolled up you stay where you were; if you were at the bottom you keep following, as before.
- **A conversation name is a name, not the prompt that started it.** Whole first prompts were being stored as the conversation's automatic name — one had grown to 27,813 characters — which bloated the stored session index and slowed every read of it. Names are capped, and existing oversized ones are trimmed on load: the index on the machine that surfaced this went from 4.4 MB to 1.4 MB.
- **File-panel row actions stop sticking.** After clicking a row, its actions stayed visible and highlighted once the pointer had moved away.
- **The desktop app focuses the composer when it opens**, so you can type straight away.
- **Plan and permission cards stay with their turn** when a long conversation fills in earlier history, instead of draining to the wrong place.

## 3.13.1 — 2026-08-20

### Added

- **Connectors — sign in to the apps you already work in.** **Settings → Connectors** ships in release builds now; it was development-only in 3.13.0. Connect Linear, Notion, Atlassian, Canva, Stripe, Sentry or Cloudflare once on this computer and every agent can use them — Grok, Codex and Claude alike. You authorise in your browser and the tokens are cached by `mcp-remote` under `~/.mcp-auth`, so the extension never handles one. The page has three sections: apps you connect here, the grok.com connectors that follow your Grok account, and local Grok connectors declared in this machine's config files. Project-file servers stay off it.
- **Copy path and Copy relative path ([#120](https://github.com/phuryn/grok-build-vscode/issues/120)).** Every row in the file panel offers both, on files and folders, on the desk and on a phone.
- **Rate a Grok turn ([#114](https://github.com/phuryn/grok-build-vscode/issues/114)).** Thumbs on a finished turn send a rating to SpaceXAI. Off by default — turn on **Thumbs feedback to SpaceXAI** in Settings → General — and they appear only where the Grok session actually supports feedback, never on Codex or Claude.

### Fixed

- **Connectors could not start at all on macOS.** A desktop app launched from Finder inherits a PATH with no Homebrew in it, so `npx` was missing. Finding it was not enough either: `npx` is a script whose `#!/usr/bin/env node` line needs `node` findable as well, so the child's environment is fixed alongside the lookup. Windows keeps its PATH exactly as you wrote it.
- **Queueing a message with images keeps the images.** Attachments were dropped when a message went to the queue — everything you attached is queued with it, or nothing is. Steer carries them too, and an image's number is stamped when you attach it and never moves afterwards.
- **The context breakdown adds up, and stays put.** The rows in the popover did not sum to the figure above them, and a breakdown could be shown against numbers from a different reading. Each one now belongs to the measurement that produced it. Settings also stopped rebuilding itself over and over while open.
- **Queued messages look like sent ones.** Images in a queued message sit below the text, where they sit in a message you have already sent, and the first message in a conversation gets a little room above it.

## 3.13.0 — 2026-08-19

### Added

- **Find in a conversation.** Long conversations were navigable only by scrolling. There is now a find bar — in the **⋯** menu on every surface, and on **Ctrl/Cmd+F** in VS Code and the desktop app (the browser keeps its own find, and on a phone the menu is the only door there was). Next and previous, a live match count, case sensitivity, and regular expressions, with `^` and `$` matching per line. It searches what you wrote and what the agent replied, plus the label on each tool row — the command that ran, the file that was read — but not the contents of those rows: searching a common word used to bury the handful of hits in your conversation under dozens from command output and diffs. Matches are highlighted without touching the page, so nothing in the transcript stops working while you search.
- **The context donut shows where the window went.** Clicking it now breaks the used space into System, Tools, Messages, Skills, MCP and Free, with the auto-compact threshold. Grok only, and it costs nothing to look: the number comes from a control-plane reading rather than a question put to the model, so opening the popover does not consume the window it is describing. Contributed by @funkpopo.
- **Icons in the gear menu and Settings.** Knowledge work and Coding carry marks, as do Report a bug, Request a feature, Contact and the repository link.

### Fixed

- **A larger chat font no longer cuts the panel in half ([#119](https://github.com/phuryn/grok-build-vscode/issues/119)).** At 200% only a fraction of the chat was visible. The stylesheet was correcting for zoom in a way browsers used to require and no longer do, so the correction became the error — and it was wrong at every setting except 100%, overflowing below it as well as clipping above. Reported by @FireInWinter.
- **Slash autocomplete stops offering commands that would not run ([#110](https://github.com/phuryn/grok-build-vscode/issues/110)).** Skills work anywhere in a message; commands only run when they start it. The popover treated both the same, so a command typed on a second line was suggested, accepted, and then quietly sent as ordinary text. Now skills are offered wherever you are typing and commands only at the start, which is exactly where each one works. Reported by @ryukenshin546-a11y and @SimonEast.
- **A file the agent reads says which file, and which lines ([#122](https://github.com/phuryn/grok-build-vscode/issues/122)).** Read rows now carry the path and the line range, and open the whole file the same way command output does. Where the range is not reported, the path shows without one rather than a guess. Requested by @padixa.
- **Settings is clearer about what it can act on.** The **Account** page is now **Remote control**, which is what it does — linking this desk to a phone or browser. Version rows for the two ACP adapters are gone: they ship inside the extension and move only when it does, so there was nothing to act on. The Codex updates row is gone for the opposite reason — it said updates were handled elsewhere, which was untrue whenever the extension had installed Codex itself.
- **A fresh clone no longer produces a file the tests cannot parse.** The repository never declared its line-ending convention, so a new checkout on Windows could rewrite a script's first line into something Node refused to read.

### Internal

- MCP server inventory, read from the agent's own rails rather than a command that cannot see managed connectors. Contributed by @funkpopo. Together with the connector work it is visible in development builds only, until a failed sign-in stops leaving a process behind.
- The unit suite stopped reporting the machine's mood: bounds that were measuring how fast a subprocess starts, rather than detecting one that had hung, made three or four unrelated tests fail per run.

## 3.12.4 — 2026-08-18

### Fixed

- **MCP tool calls show what went in and what came back.** An MCP call was a single line with no way to see the arguments or the result. It now gets the same expandable IN/OUT block shell commands have, on all three agents — which took measuring each one, because they agree on nothing: the tool name, the arguments and the result each live somewhere different, and two of the three send no `content` at all on completion. Grok's internal tool-search rows fold into the explore group instead of cluttering the transcript, and a Codex server that genuinely fails to start still says so.
- **Long tool names stay readable.** A name like `mcp.codex_apps.codex_document_control.list_documents` was cut at the end — exactly where the useful part is, leaving a column of rows that all read the same. Long names now elide in the middle, keeping both ends, and hovering shows the complete name.
- **Skill search looks at descriptions, not just names.** A skill you remembered by what it does rather than what it is called was unfindable. Matching now covers descriptions, name matches still rank first, and the matched words are highlighted wherever they landed so a description-only hit makes sense.
- **Opening a long conversation no longer scrolls endlessly.** Loading a big conversation replayed every message while forcing the view to the bottom after each one — roughly fifteen hundred times on the largest conversations here, which read as an infinite scroll that only stopped when you switched away. The view now settles once, at the end, and loading is quicker for it. Opening the same conversation twice at once can no longer interleave two copies of its history either.
- **Grok conversations stop jumping in Recents when you open them.** A `session/load` rewrites `events.jsonl`, so ranking by that file promoted whatever you had just opened — and, because the previously-opened one carried a fresh stamp too, it often looked like the *previous* conversation jumping. Grok now ranks by `updates.jsonl`, which a load leaves alone and a real turn advances, so work done in the terminal still promotes a row. **Claude conversations can still jump** — its listing time is restamped on open and the pinning that should hold it does not yet survive in practice; Codex was never affected.
- **A live turn no longer dies at 30 minutes with `ACP request timed out: session/prompt` ([#117](https://github.com/phuryn/grok-build-vscode/issues/117)).** `session/prompt` stays open for the whole turn, but the client armed a one-shot 30-minute timer that streaming `session/update` traffic never reset — so a healthy long job (training, a long tool loop, many slow steps) was cut while the agent was still working. The timer is now idle-based: any ACP traffic re-arms it (default 30 minutes of silence). A 24-hour absolute cap remains as a safety net. Tune `grok.acp.promptIdleTimeoutMs`, `grok.acp.promptAbsoluteTimeoutMs` (`0` disables), and `grok.acp.requestTimeoutMs` on newly started sessions.
- **MCP tool results show the whole payload.** Codex rows that only printed a terse `Action completed.` were dropping `structuredContent` — where Gmail and similar servers put the actual messages. OUT now carries the text and the structured JSON, and a failed Codex call shows its error instead of an empty box. Pretty-printing that JSON stops at the 100K display cap so a nested result cannot expand into megabytes first, and a Claude JSON string is shown as the adapter sent it so 64-bit identifiers are not rounded.
- **Stopping a command still shows [Cancelled] when the browser is newer than the desk.** An older host that never sent a cancellation flag was being read as "not cancelled", so a genuine Stop lost its marker. The host now always says whether it was a kill.
- **Reopened conversations show shell command output again (#44).** Switching away from a live Claude conversation and back no longer drops the command's output.

## 3.12.3 — 2026-08-18

### Fixed

- **The desktop app no longer dies when a phone or browser connects.** Opening a remote client while the app happened to be refreshing its voice settings could crash it outright — a Windows error dialog and a dead window, not a degraded feature. A background file watcher was asking a client that had connected but not yet finished its handshake which project it was on, and treating "not ready yet" as a fatal error. It now waits for that client instead, and the same assumption has been corrected everywhere else it was made.
- **Dragging a panel edge follows your cursor when the UI is zoomed.** The rail and the file panel both jumped on grab and then drifted further from the pointer the further you dragged, because the drag was measured in screen pixels while the layout was in zoomed ones. Both now agree. At the default zoom nothing changes.
- **Codex shows which MCP tool it ran.** Calls to MCP servers appeared as a bare `Run`, so a row of them told you nothing — the name was on the wire, but a generic label was taking precedence over it. They now read as `mcp.<server>.<tool>`, matching how the same calls already appeared for Grok and Claude.

## 3.12.2 — 2026-08-18

### Fixed

- **Stray "New session" conversations stop piling up.** Checking whether an agent is signed in quietly started a real conversation and then tried to end it — but that particular cleanup never worked, so every check left an empty conversation behind. They showed up as identical "New session" rows you could not open (the CLI cannot load a conversation with no messages) and that survived **Clear all**. The check now runs somewhere harmless and removes after itself, so nothing new accumulates. Anything already on your disk stays where it is and is inert; it was never taking part in your work.
- **Clear all history finishes the job.** It deleted the files while the agent processes were still shutting down, so on Windows the delete could fail — or the CLI would write the conversation back — and the rows returned. It now waits for those processes to exit first, and refreshes the project list for projects other than the one you are looking at.

## 3.12.1 — 2026-08-17

### Fixed

- **The desktop app opens on a fresh install instead of hanging (#116).** Launching with no project configured sat on "Starting" forever. The app asked itself to open a conversation, found no folder to open it in, and returned without ever telling the window it had stopped working — so the loading state had nothing to clear it. Reported by @ffgrep, who also found the workaround: adding a project, or setting `workspaceRoots` by hand.
- **A first run now has somewhere to work.** Rather than asking you to understand projects before you can send a message, the app creates a **Grok Build** folder in your home directory and starts there. It happens once, only when you have no projects at all, and it is an ordinary project you can remove — adding your own stops it being offered again. Plenty of people want this for chat or knowledge work and have no reason to think about project organisation.
- **Removing every project gives you an empty state, not a spinner.** It names what is needed and offers **Add project folder**, and starting a conversation stays blocked until you add one — the same dead end was reachable that way too.

## 3.12.0 — 2026-08-17

### Added

- **Colour, rename and opening a conversation happen the moment you do them.** Picking a project colour, renaming a conversation, or opening one from the rail or history used to sit still for a second or two while the host was asked and answered — longest in the browser, where every confirmation makes a round trip to your desk. All three now apply immediately. Renaming anywhere updates every surface at once, so the top bar no longer shows the old name after you renamed it in the history list. Opening a conversation switches the title and holds the messages panel on a loading state instead of leaving the previous transcript sitting under the new name. Your desk stays the authority throughout: if it disagrees, or never answers, the display returns to what it actually says.
- **Maximize the file panel in the browser.** afkpilot.com on a monitor docks the panel beside the chat, exactly like the desktop app — but had no way to give it the whole window. It does now, with Escape to restore. On a phone nothing changes: the panel already fills the screen there.
- **Provider marks on Settings → Providers.** Each row carries its agent's mark, so Grok, Codex and Claude Code are identifiable at a glance rather than by reading down a column of names.

### Fixed

- **Opening a Grok conversation no longer runs it on a different agent.** With Grok disconnected, opening a Grok conversation from the rail reported "Failed to start Codex" — and it meant it: the conversation had been quietly handed to whichever agent could answer, because a freshly opened session looked empty before its history loaded. A conversation now keeps the agent it belongs to, and if that agent cannot answer you are told so by name. The wrong error text was the visible symptom; running your conversation on an agent you did not choose was the actual bug.
- **Refresh finds an agent you signed into somewhere else.** Approving Grok in a browser and pressing Refresh in Settings → Providers did nothing, because it only re-checked accounts already marked connected — which is precisely the case you press it to fix. Every installed agent is re-checked now.
- **The ⋯ menu stops closing itself while projects load.** Opening it during the first seconds after a window opens had it vanish every few seconds until the project list settled.
- **The browser matches the editor's text size.** afkpilot.com on a desktop rendered a size larger than the same UI in VS Code or the desktop app, because the browser has no editor font setting to inherit and fell back to its own default. It now matches at 13px. Phones and tablets are unchanged — text stays at the larger size the touch layout was designed around.

## 3.11.0 — 2026-08-17

### Added

- **Settings → Providers can be made to tell the truth.** The page said whether Grok, Codex and Claude were connected, but nothing ever re-checked: sign out inside a terminal, install a CLI, let a token lapse, and it kept repeating whatever it last heard. There's now a **Refresh** button above the list, and opening the page runs the same check on its own. It re-looks for each CLI and re-tests the accounts that are actually connected — it never marks an account connected on your behalf, so a refresh can only ever tell you what is true. The button says "Checking…" while it works. On the phone the list stays read-only, as it was, but it updates the moment your desk re-checks.

### Fixed

- **The VS Code settings tab keeps up with your accounts.** Opened as an editor tab, Settings → Providers only ever showed the state it started with — connect or sign out anywhere else and that tab never heard about it, so it could sit there contradicting the sidebar until you closed and reopened it. It now receives the same live updates every other surface gets.

## 3.10.1 — 2026-08-16

### Fixed

- **Grok can see the images it opens (#79).** Asking Grok to read a `.png` or `.jpg` came back `Cannot read binary file`, while the same CLI in a terminal described pictures happily. The cause was on this side: the extension told the CLI it could resolve files on its behalf, and that routed *every* read — images included — down a text-only path with no image branch. It no longer does, so reading a picture reaches the CLI's own image-aware path and the model actually sees it. Generated images, screenshots a subagent produced, anything Grok opens by path. Pasting and attaching images were never affected — those always sent the pixels, and still do. Applies to grok CLI 1.0.4 and newer, where that image-aware read exists; older CLIs keep their previous behaviour, and Codex sessions are unchanged.
- **Codex Auto accept stays Auto accept.** Codex reports Plan/Default and Agent/full-access as two options on every snapshot. Treating collaboration `default` as the host mode discarded `agent-full-access`, so picking Auto accept snapped back to Agent and approving a plan from full-access implemented under an Agent badge.
- **A rejected Plan switch no longer leaves the Plan badge up.** The toolbar followed the click, not `session/set_mode`. When that RPC failed, Claude and Codex stayed writable (no client gate) while the UI claimed Plan.
- **Plan mode blocks a command that arrives in the same stdout chunk as the switch.** Raising the client gate after `await setMode` left a window: readline can deliver the success reply and a `terminal/create` in one turn, and the handler still saw the gate down. A successful Plan reply now commits the gate in the response hook, before the next line is dispatched. A refused switch still leaves the badge and gate unchanged.

## 3.10.0 — 2026-08-15

### Added

- **Touch sizes for real fingers.** On phones and tablets the whole UI steps up: 15–16px text in the rail, file tree and panel (reading prose goes 12 → 15px), every row you tap is at least 36px tall — including the project headers and tree rows that quietly sat under the floor — and every tap target meets one universal 36px minimum with zero exceptions. Text inputs go 16px on touch, which stops iOS Safari's zoom-lurch when you focus the search or the composer. The code viewer deliberately keeps its smaller type: columns beat point size on a phone. Desktop and mouse layouts are pixel-identical to before.
- **File tabs that behave like tabs.** The file panel's strip stops scrolling: named tabs shrink to icon-only, then overflow into one "…" chip styled like a tab — and whatever fits shows its whole name, extension included, so `.env` and `CLAUDE.md` read fully instead of becoming `…`. The active tab always keeps its ✕ and its name; maximize/minimize sits pinned at the right and can never silently disappear; on desktop, maximize gives the panel the whole window until Escape.
- **A real mode switcher in the file viewer.** Reader and Source are a proper segmented control with a filled selected state; Cancel, Save and ⋯ sit at the right end; and both "…" menus now close when you tap their button again.
- **One icon scale everywhere.** Every top-bar icon rides the same 20px glyph in an invisible touch-sized hit box with color-only hover — chat header, file panel and rail now measure identical on the phone.

### Fixed

- **Refreshing the phone lands in your conversation, directly.** The page holds a quiet "Restoring conversation…" instead of flashing a blank New session (title bar included) and then swapping. Restores survive a just-reloaded desk (the host waits out its own cold start instead of refusing), a genuinely failed restore says so once and hands any queued text back to the composer — including text queued mid-turn, which used to vanish — and a brand-new empty session refreshes clean instead of announcing "could not restore" over phantom "queued actions".
- **Transient agent hiccups stop painting terminal errors.** A failed provider start retries quietly before surfacing; a process that dies mid-startup can no longer be treated as running (which could silently swallow an automatic sign-in retry); and "exited (code 0)" on an empty conversation — a clean exit with nothing to say — no longer renders as a red must-restart banner.
- **Worktree dialogs answer the conversation they were opened for.** Fork, apply and remove name their session on the wire and the host refuses a mismatch, so a confirmation answered after switching conversations can never land on the wrong one.
- **Just the conversation name.** The repository suffix under session names is gone on every surface — the rail already says which project you're in.
- **The `/` command popover hugs its content** instead of spanning the whole composer.

## 3.9.0 — 2026-08-14

### Added

- **Parallel subagents stop scrambling the chat.** The CLI streams every agent's words onto one wire, interleaved mid-sentence — and the transcript used to paint them that way (#62). Each subagent now gets its own card in the conversation: collapsed with a live one-line status while it works, expandable to its own transcript of prose and tool calls, with the parent's narration staying coherent above it all. Old CLI versions that never interleaved behave exactly as before.
- **All settings, one place.** A full settings surface — search with `/`, categories with icons, one row per setting with a sentence that says what it does. On desktop and the phone it opens over the app with **← Back to app** as the exit; in VS Code it's an editor tab plus a native gear icon on the Grok view's title bar. The gear popover slims down to quick actions and one Settings entry. **About** lives at the bottom of Settings now — versions, update check, report-a-bug and feature-request links, and a support contact. Restore defaults confirms first with a concrete list, and never touches things you wrote yourself (voice dictionary, send phrase).
- **Voice's fiddly bits are editable** — the spoken send phrase and the recognition dictionary, from any client including the phone, saved to the config scope that actually wins.
- **The telemetry switch is visible.** The existing anonymous-usage setting has a real toggle on desktop and a row everywhere, with the honest description: one anonymous session-start event, never prompts, code, paths, or identity; the IP address is discarded, never stored.
- **Devices tell afkpilot.com what they are.** Linking (and every reconnect) now reports the client kind and OS, so the device list can show "DESKTOP-X (VS Code extension, Windows 11)" with the right OS mark — existing devices label themselves on their next connect, no re-linking needed.
- **Unlink from the desktop app** — gear → Your account → "Unlink this device…", with a native confirmation naming the machine. The palette-less desktop finally has the deliberate path (#112's side-finding).

### Fixed

- **Desktop opens in its real layout.** The brief flash of the old panel-less UI before the rail and file panel arrived is gone — the full three-column chrome paints from the first frame.
- **Rail menus stop growing sideways.** Context menus cap at a sane width with ellipsis instead of stretching as wide as their longest entry.
- **The gray idle dot next to provider logos is gone** — the logo already says which agent owns the session; the dot only returns for states that mean something (working, needs you, unread, error).
- **"How it works" tells desktop users the truth** — "Keep this app open," not a list of editors you're not using.

## 3.8.0 — 2026-08-14

### Added

- **The desktop app updates itself.** Windows and macOS builds check quietly in the background, download the new version while you keep working, and the rail button becomes **Restart to update** when it's staged — one click installs silently and brings the app right back. A normal quit installs it too. No wizard, no SmartScreen detour, no download page: that whole trip now exists only as the fallback when the feed is unreachable. An in-flight reply is never interrupted — the update waits for your click or your next quit.
- **Typing part of a command's name finds it.** `/rev` matches `/code-review` now, not just commands that start with those letters — commands beginning with what you typed still list first (#110).
- **Anonymous usage telemetry knows the app from the editor.** The one existing session-start event now says whether it came from the desktop app or VS Code, and which settings shape the session (mode, model, effort, thinking traces, voice on/off, which agents are connected). Strictly enums and booleans — a new test proves no path, filename, or free text can enter the payload, and any value the app hasn't actually measured is omitted rather than guessed. The full field list is in docs/privacy.md.

### Fixed

- **The projects rail no longer vanishes on desktop startup.** Opening the app with a restored conversation could boot into a chat with no left rail at all — every time, on some machines — until a hard reload brought it back. The startup handshake was mistaking its own just-started session for a window reload and skipping the project list on the strength of it.
- **The desktop window can no longer open scrambled.** An occasional first paint had the content shifted and cropped at both edges, panels pushed off-screen, zoom applied twice. The window now shows only once the page can measure it, the app's zoom is the only zoom, and a boot-time focus can no longer scroll the layout into a stuck state.
- **Your history is there before the agent is.** With the CLI still starting — or not installed at all — conversations on disk now list and open read-only instead of showing an empty rail behind a blank onboarding screen.
- **Grok 4.6** replaces Grok 4.5 across the listing and manifest, and packaging keeps the Codex adapter's dependencies out of the shipped artifacts (5.2 MB vsix, 17 MB desktop asar — with the ~350 MB Codex platform binary provably excluded from both).

## 3.7.0 — 2026-08-13

### Added

- **OpenAI Codex can run alongside Grok.** Connect it from the gear in VS Code or Settings on the desktop; models from both providers share one picker, every conversation keeps the provider it started with, and both providers' sessions sit side by side in the rail. No Codex CLI installed? The app offers to install a pinned, checksummed copy for you. A phone sees which providers are connected; signing in and out stays at the desk.
- **Export a conversation as Markdown.** In the conversation's ⋯ menu on every surface — VS Code opens it as an untitled document, the desktop asks where to save, the browser downloads the file. Rewound turns and hidden bookkeeping never leak into it, and an export of a partial phone history says so instead of passing as the whole conversation.
- **The VS Code chat grew its own ⋯ menu.** Continue in a new chat moved there from the gear, alongside the new export — per-conversation actions live with the conversation now.
- **"View all" and proposed diffs open inside the desktop app.** A themed, syntax-highlighted overlay with Copy and Save As replaces the bare read-only window that knew a file's language but couldn't paint it.
- **Copy Link.** Right-click — or long-press on a phone — a link in the transcript to copy its real address; file references copy their path.
- **Shell scripts can be saved from the file panel.** Editing `deploy.sh` or a `.ps1` was refused with "executable path refused" — a check written to stop the operating system *launching* a file, reused to decide whether you were allowed to *write* one. It stopped only the person: ask grok to edit the same file and it always could. The refusal stays exactly where it belongs, on Open in default app and Reveal. `.bat` and `.cmd` also open in the panel now, which `.sh` and `.ps1` already did.
- **Opening a conversation logs where the time went.** One line in Output → Grok splits the open into its phases, so a "sometimes slow" report can carry numbers instead of an impression.

### Fixed

- **The chat no longer scrolls away from the bottom on its own.** With the UI zoomed and tool details expanded, answering a permission card — or just a growing reply — could unpin the view and bring the "Scroll to bottom" button back every turn. Only a real gesture (wheel, touch, scrollbar, paging keys) unpins now; a reader who scrolled up to read history stays exactly where they are.
- **"View all" opens with a language.** A command opens in your shell's language, and output is no longer forced to Plain Text, so the editor can recognize JSON, logs and generated code.
- **Copy and the timestamp under a message are readable without hovering.** They rest dimmed instead of invisible — and on a phone they take a direct tap, no gesture first.
- **Plan mode is no longer lost to a slow version check.** A first `grok --version` after install can time out (Windows antivirus is the usual cause). The last verified version for that binary is remembered, so a failed probe keeps Plan when the file has not changed. That memory is only a stand-in — picking Plan checks again — so a later update is not stuck behind a stale reading, and a live check still replaces the stand-in either way. A live reading of an old CLI is still refused. The disabled message now says the check failed and that picking Plan again or reloading retries it.
- **Windows machines can sleep with the chat panel open.** The first click created an audio session and never released it, even with every sound setting off. The session is created only when a sound is actually on, and it is suspended again once the tone finishes.
- **Everything you tap on a phone is at least 36px.** The rename pencil was 22px — below the accessibility minimum — and the file-panel toggle, the one you use to reach files at all, was 28. Save and Cancel were 26 tall. Mouse-driven windows keep their compact controls; the larger targets appear only where the pointer is a finger.

## 3.6.0 — 2026-08-12

### Added

- **Code in the file panel is syntax-highlighted — while you read it and while you type.** Every file that was not Markdown or JSON opened as flat grey text: fine for a glance, tiring for anything longer. Around sixty file types now colour their comments, strings and keywords, and the colours stay when you switch to editing rather than vanishing the moment you tap Edit. It is our own highlighter rather than a library — the panel runs under a strict content policy that cannot load one, and the alternative was ~200KB of parser in every page load for something you mostly skim.
- **`.sql` and about twenty more file types open in the panel at all.** They used to be handed to the operating system, which on the desk is a detour and from a phone means they could not be opened. `.scss`, `.ini`, `.conf`, `.rb`, `.php`, `.kt`, `.swift`, `.cs` and `.diff` are among the rest.
- **A link in a README opens the file it points at.** Tapping `_shared/auth.ts` in a rendered Markdown file was treated as a web address, so from a phone it navigated away from the app entirely. It now opens that file as a tab. Links that really do point at the web still go to the browser.

### Fixed

- **Referring to an image the agent could not find.** Attach a picture, attach another in a later message, and asking about the second failed with *"does not match any attached image"*. The tag said `#2` because it was the conversation's second image; grok counts the images on the message it is reading, where it was the first. Images are now numbered from 1 in every message — in the tag and in what you see — so the number you read is the number the agent was told. Two pictures in one conversation are both "Image #1" now, each in its own message, which is the trade that makes the reference work at all.
- **Deleting the last empty line of a file, and having it come back.** The editor said "Saved." while the file on disk kept the newline you had just removed. Saving a formatted `.json` had the mirror-image problem: it quietly *removed* the final newline every time, so `package.json` came back with a spurious change after any edit.
- **The file panel is the whole screen on a phone and a third column on a desktop — never something in between.** At tablet widths it floated over the middle of the chat with the projects rail showing behind it. Below the width where it can sit beside the conversation it now takes the screen, and the panel's own close button brings you back. Files no longer carry individual close buttons there — two small targets side by side, and a project tab that looked closable but was not.
- **A file that cannot be previewed opens as a tab, with the reason inside it.** The message used to be painted over the file tree with no tab at all, so nothing told you which file had failed, and the tree's search box stayed on screen above it. On the desk the file was also handed straight to your operating system before you could see what it applied to; *Open in default app* is now offered inside that tab instead of taken on your behalf.
- **"More actions" in the file viewer opens.** On Grok Build Desktop the button did nothing, silently — the click that opened the menu was also the click that closed it.
- **A conversation you send to rises up its project in the rail.** Sending in one project never told a connected browser that a *different* project had just become active, so its position there went stale.

## 3.5.0 — 2026-08-11

### Added

- **The browser gets the desktop's file panel — the same one.** Browsing files from your phone was a different piece of software from the panel in Grok Build Desktop: a flat list you stepped through, one file at a time, floating over the chat. It is now literally the same panel — a tree you expand in place, several files open at once as tabs, and on a wide screen it docks beside the conversation instead of covering it. On a phone it still opens as a drawer, because a phone has no room for a third column. There is one renderer now instead of two that drifted apart every time either was touched.
- **Version & about describes the machine you are driving.** On a phone the page said "This extension" over a "Checking for updates…" that never finished — the desk machine's own panel, shown to a device that is neither the extension nor able to update anything. It now says what you are holding, what it is connected to, and the two versions installed over there. No update button: the binaries live on the desk machine and only the desk can replace them.
- **Opening a conversation from GROK: PROJECTS brings the chat forward.** The rail has its own icon in the activity bar, so a click could load the conversation behind whatever view you were looking at and read as having done nothing.

### Fixed

- **Saving no longer throws you out of the file, or moves your cursor.** A successful save dropped you back to the read view, so carrying on meant clicking Edit again — for the ordinary habit of saving as you work. It also rebuilt the editor, which sent the caret to the top and lost your selection and scroll position. You now stay exactly where you were.
- **The right-click menu in the file panel respects zoom.** It was placed at raw pointer coordinates while the chat scales, so the further from the top-left you clicked, the further away the menu appeared. It also could not flip up and had no bottom clamp, so it could open off the screen.
- **The file panel's toolbar buttons are visible.** Every icon on the open-file row rendered as an empty box.
- **Markdown reads like every other file type again.** It had become the only kind with a worded toggle while everything else got an icon, so one toolbar looked like two designs.
- **Conversations sit at one spacing everywhere in the rail** — including under a section label, which used to sit noticeably further from its first row than the rows sat from each other.
- **The project name is no longer truncated when nothing sits beside it**, and the shading behind a row's hover actions matches the row rather than the panel.
- **The VS Code rail stopped re-reading every project on every refresh.** Each refresh asked every other project for its conversations again — a full pass over its history — even when nothing about it had changed.
- **A phone can no longer start a CLI update on your desk machine.** The status still travels, so you can see the CLI is behind; acting on it belongs to the machine it is installed on.

## 3.4.0 — 2026-08-10

### Added

- **Archived projects stay on the desk.** A project you have filed away no longer appears on your phone, and its conversations, files and pinned rows go with it. Working in it again at the desk brings it back. Opening it in VS Code keeps it visible throughout — filing something away was never meant to hide the thing you are looking at.
- **Opening a conversation now says where its time went.** The log records each phase of an open — waiting for the previous CLI to exit, checking its version, starting it, loading the transcript — so a slow one can be explained instead of guessed at. Measured first: ordering 1,786 conversations takes 190ms, so the wait was never the history list.

### Fixed

- **Renaming a conversation no longer makes the top bar jump.** The rename pencil is a fixed-height button and the tallest thing in that row, so hiding it collapsed the row and took 7px off the whole bar, dragging the project line and the separator up with it.
- **The top-bar icons sit level.** They were 2px from the top edge and 15px from the rule underneath, left behind when the conversation name grew a second line.
- **A file type is no longer linked as a file.** "The main `.md` files" turned `.md` into a link to nothing; a bare extension names a kind of file, not one you can open. `.env` and `.gitignore` still link, being real filenames.
- **A crashed CLI no longer keeps a worktree slot forever.** If it died while a worktree was still being copied, the dead process stayed referenced until the window closed.
- **The extension's own docs name SpaceXAI** where they describe who makes Grok. The trademark line still reads xAI, which is what the rights holder's own brand guidelines ask for.

## 3.3.1 — 2026-08-10

### Fixed

- **Menus in the projects rail stop running away from the pointer.** On a wide rail a menu opens at the right-hand edge, next to the ⋯ button — far enough from the click that the "you have walked away" rule closed it before you could reach it. Walking away is now something you can only do after arriving.
- **"Set color" opens its swatches where the menu was.** Right-clicking a project opens the menu under the pointer, but choosing Set color threw the colours back across the rail to the ⋯ button, out from under the cursor that was following them.

## 3.3.0 — 2026-08-10

### Added

- **A projects rail in VS Code**, with its own icon in the activity bar. Every project Grok has worked in, side by side: pinned conversations, the ten most recent across all of them, and each project's own list underneath. Until now VS Code showed you one project — whichever folder the window had open — and everything else was invisible unless you reopened the window somewhere else.
- **Open a conversation from any project without leaving the one you are in.** Nothing reloads. The chat follows the conversation, and so do New Session, worktrees, and the file chips — a conversation in another project no longer quietly attaches a file from the folder VS Code happens to have open.
- **Browse your project's files from a browser, and edit them.** Open a text file on your phone, change it, save it. Images preview but cannot be edited; nothing else can be read or written, and every path is checked against the repository that tab has selected.
- **Projects can be added to the rail and hidden from it.** Adding one records it rather than reopening the window — VS Code turns a single-folder window into a multi-root one and restarts the extension host, which is not a reasonable price for putting a folder in a list.
- **Projects file themselves away when they go quiet.** Anything untouched for a month, and anything with no conversations at all, moves to an archive group; working in one brings it straight back. Opening a project in VS Code always lifts it to the top, marked **Your IDE**.
- **Projects can have a colour in VS Code**, as they already could on desktop and the phone.

### Fixed

- **Worktrees work again, and the reason they didn't is worth stating.** Not every worktree the Grok CLI makes is a `git worktree` — for some repositories it makes a full copy instead, which the original repository's worktree list will never mention. So a perfectly good checkout was created and then rejected as unrecognised, and the retry that appeared to succeed had actually been waved through on the CLI's own say-so, sometimes onto an empty folder where the agent then failed to start. Both halves are fixed: git is asked first and always, and a copied checkout is verified from a file on disk rather than taken on trust.
- **"Remove worktree failed: Internal error."** The CLI deletes the checkout and *then* fails to deregister it, so what was left was an empty folder and an error you could do nothing about. That leftover is now removed for you. A creation that *is* rejected also tells you where the checkout was left, instead of leaving orphans behind silently.
- **The rail's menu did nothing.** Rename, Delete, Clear all history and Hide project were all silent — VS Code disables the browser prompts they relied on, and every one of them read that as "cancelled". They ask properly now, which is also why the lists had looked frozen: nothing had happened to refresh them.
- **Recent updates when you send a message.** It ranks by when a conversation last changed, and that clock is written by the agent, not by the extension — so there was no moment on our side to notice. The end of a turn is now that moment.
- **Menus close when you look away.** A click anywhere else in VS Code never reaches the rail, so an open menu had no way to know it had been left behind. Moving the pointer well away from it closes it too.
- **"Move to Projects" appeared on projects already in Projects**, because the menu read a stored flag while the rail places rows by how recently you worked in them. The action follows the group the project is actually shown in.
- **A conversation's project is named under its title**, not beside it, and the rename pencil stayed where it belongs instead of dropping to a line of its own.
- **Deleting a conversation no longer fails with a directory-not-empty error on Windows**, which happened when anything still had the folder open for a moment.
- **Plan mode stops disappearing because a version check was slow.** Only a CLI actually verified as too old turns it off now, and the message says the version could not be checked rather than implying the CLI is out of date.
- **Grok Build Desktop's prompts look like dialogs.** The worktree prompt in particular was a window with rules across the top and bottom, no padding, the stock Electron icon, and a maximise button — a small web page rather than a question.

### Changed

- **Clicking a conversation in the VS Code rail highlights it immediately**, instead of waiting for the conversation to load. It has always worked that way on desktop, where the rail and the chat share a window.
- **"Current" is now "Your IDE"**, and it means the folder VS Code has open — not whichever project you were last looking at in the rail.
- **Section labels in the VS Code rail scroll with their conversations** rather than staying pinned at the top of the panel.
- **xAI is named SpaceXAI** where the non-affiliation notice says who we are not affiliated with. The trademark line still reads "of xAI", which is what their own brand guidelines ask for.

## 3.2.11 — 2026-08-09

### Added

- **Projects can have a colour.** Give each project a coloured folder in the conversation rail — *Set color* in its ⋯ menu, six colours or none. The choice is stored with your projects rather than in one browser, so it follows you to your phone. Desktop and browser.
- **Right-click works wherever ⋯ does.** Projects and conversations in the rail, files and folders in Grok Build Desktop's file panel — right-clicking opens the same menu the ⋯ button does. Not on touch, where a long press already means something.
- **Folders can be revealed in Finder or Explorer**, not only files, and the file panel's row actions now live in a ⋯ menu like the conversation list's do.

### Fixed

- **Conversations stop jumping to the top of the list for being opened.** Opening one rewrites its record on disk, and the list read that as activity — so merely looking at an old conversation promoted it above ones you had actually been working in. The list now follows the conversation itself. Measured against a real store of 1,592 conversations: 46 were sitting higher than they had earned.
- **Closing a project takes one click.** Clicking an unselected project used to switch into it and force it open, so the first click on an already-open one appeared to do nothing. It also left the chat on one project while the rail claimed another; switching now follows from opening a conversation, which is what made that state coherent in the first place.
- **The conversation list stops flickering while a conversation opens.** The row buttons blinked under a stationary cursor, and an open ⋯ menu was closed again on every refresh — so it could not be used at the moment you most wanted it.
- **The store listing printed "Install" and "Quick start" twice.** It is generated from the project README, and the generator was adding its own copy on top of the one already there.

### Changed

- **Clicking a conversation highlights it immediately** instead of waiting for it to load, so a click never looks dropped. The few actions that act on "whichever conversation is open" — continue in a new chat, and worktree apply/remove — grey out for that moment, because until the load finishes there is genuinely no safe answer to which conversation they would act on.
- **One waiting animation everywhere.** The status line's growing ellipsis is gone; everything that is working now shows the same three blinking dots, and they hold still if your system asks for reduced motion.

## 3.2.10 — 2026-08-09

### Fixed

- **Generated videos play, and 3.2.9 was wrong about why they didn't.** That release said the browser engine ran out of video decoders and stopped reserving one per clip. It wasn't the decoders, and it didn't work. The real cause: Grok Build Desktop served every file whole, ignoring the "send me this part of it" requests a video player makes as it plays. Playback would start, run about a second, and die. The app answers those requests properly now. Measured against the clips that failed: 4 failures in 45 attempts before, none in 45 after. *This is Desktop only — in VS Code the editor serves the file itself, and that path is not ours to fix.*
- **A video shows its first frame again, instead of an empty box that jumps.** The preview 3.2.9 traded away comes back now the byte-range problem is actually fixed, and the clip is the right shape before you press play rather than snapping to it afterwards.
- **The chat scrollbar sits against the edge of the pane.** At a small chat font on a wide window it floated well inland — the further in, the smaller the font. The text column is still a comfortable reading width; it just no longer drags the scrollbar with it. Desktop only.
- **Clicking a conversation moves the file panel to its project.** Clicking a *project* always did, and so did starting a new conversation, which is what made it look arbitrary. Desktop only.
- **Links to a plan open the plan.** Plans are written outside your project, so clicking one did nothing at all — no window, no error.

### Changed

- **A generated image or video now offers "Show in folder" in Grok Build Desktop.** Opening the file gave you nothing you couldn't already see: clips play in the chat, and pictures enlarge in place. Finding the file is the useful thing. In VS Code the button still opens an editor tab, which is what an editor is for.
- **The composer drops the words beside its two icons when it is narrow.** "Agent mode" and the token count give way to the icon and the ring; the tooltips carry what the labels stopped saying, including which mode is active.
- **Recent lists ten conversations, not twenty**, and the file panel's title and tabs line up with the rows beneath them.

## 3.2.9 — 2026-08-08

### Fixed

- **Links to generated images open.** When Grok makes a picture it usually links to it in its reply as well, and it writes that link relative to the conversation rather than to your project — so clicking it went looking in your repository for a file that was never there. Grok Build Desktop answered *"File not found … It is not under the open project"*; VS Code simply opened nothing. Those links now find the picture that was actually generated. The image in the transcript was always right; it was only the link beneath it that missed.
- **The open-file button on a generated image works in Grok Build Desktop.** Generated pictures live in Grok's own conversation folder, which sits outside your project, so the button was refused every time it was pressed. It is now allowed for that one kind of file — a picture or video Grok generated for one of this project's conversations — and for nothing else. Everything the app opens on your behalf is still held to the same containment checks as before.
- **Generated videos play after the first few.** Every video in a conversation reserved a decoder the moment it appeared, whether or not anyone watched it, and enough of them in one chat exhausted the browser engine's pool — after which pressing play on some clips did nothing, and which clips varied. A video now reserves nothing until you press play. The trade is that a clip shows an empty frame rather than a preview until it starts.
- **A clearer answer when video generation is blocked by your account settings.** xAI refuses video generation on accounts with zero data retention, and says so by naming an API field you cannot supply. Grok Build now adds where the setting actually lives: the Grok CLI's `/settings` → Privacy → Coding data, retention, and training.

### Changed

- **Clicking a generated image enlarges it where there is no editor to open it in.** In Grok Build Desktop and in the browser client the picture now opens full-size in place. Previously the browser left it inert, and Desktop handed the file to whichever program your system uses for images — leaving the app to show you something already on screen. In VS Code the click still opens an editor tab, which is what an editor is for.

## 3.2.8 — 2026-08-08

### Fixed

- **The chat opens in Cursor.** Cursor reserves the secondary side bar for its own agent UI and refuses to place an extension there, so the panel Grok Build asks for was never created — the view was dropped into Explorer and every way of opening it answered "command not found". It now opens the view wherever the editor actually put it.
- **A fresh install lands somewhere you can see it.** On the very first run — and only then — a chat the editor has stashed somewhere unusable is moved into its own view. It has to happen without you opening anything, because someone whose chat is buried in an Explorer section has no way to open it. After that first run the placement is yours and nothing touches it again: there is no way for an extension to ask where its own view sits, so we cannot tell someone who deliberately moved it from someone who never did, and guessing would mean dragging your layout back after every update.

### Changed

- **Move view now appears only where the editor needs it**, as a single **Move view…** that opens the editor's own destination picker; **Grok: Move Chat View** does the same from the command palette. The three fixed destinations are gone. In an editor with a secondary side bar they duplicated a **Move To** it already offers, and in one without, all three led to the same place — because a container is not a location, and an editor is free to draw our containers wherever it likes. Its own picker moves by location, which is how it reaches docks we cannot name.
- **Move view is hidden in the browser client.** Where the chat sits is a property of the machine running the extension, so those entries could never do anything from a phone.

## 3.2.7 — 2026-08-08

### Changed

- **Grok Build Desktop for macOS is signed and notarised by Apple.** It opens on first double-click — no *unidentified developer* warning, no trip through Privacy & Security, and no *"damaged and can't be opened"* on Apple silicon. Installers on this release are the first signed ones.

### Fixed

- **Voice finds ffmpeg where it is actually installed.** The desktop app only searched the `PATH` it inherits, which on macOS leaves out Homebrew's directory — so `brew install ffmpeg` looked like it had done nothing, and voice kept reporting ffmpeg missing until you pointed a setting at the binary by hand. It now checks the standard install locations too.
- **A useful answer when ffmpeg is missing.** The error offered only *Open Settings*, which cannot help when the program isn't installed at all — it sent you to a text field to name a file you don't have. It now shows the install command, and on macOS offers to open a terminal with it typed ready to run. Pointing the setting at a folder instead of the program is also named as such, rather than failing as a permissions error.

## 3.2.6 — 2026-08-08

### Fixed

- **The extension loads again.** 3.2.0 through 3.2.5 failed to start: a module the sidebar needs at runtime was left out of the published package, so activation threw before a single command was registered — every `Grok:` command answered "command not found" and the sidebar never appeared. Update from any 3.2.x; the downgrade to 3.1.0 is no longer needed. Grok Build Desktop was never affected. Found and diagnosed in #101.
- **Packaging refuses to build a package that cannot load.** Every `require` in the packed code is now resolved against the files actually being shipped, so a missing module fails the build instead of reaching a marketplace.

## 3.2.5 — 2026-08-07

### Changed

- **"Update available" opens a page that just gives you the download.** It used to open the GitHub release, which lists ten files — installers for three platforms, their checksums, and the VS Code extension — with nothing saying which one is yours. Now it detects your platform, offers one button, and shows how to get past the first-launch warning.

## 3.2.4 — 2026-08-07

### Added

- **Hide a project from the desktop rail** — in a project's `⋯` menu. It leaves the list; nothing leaves your disk, and **+** adds it back.

### Changed

- **Projects are listed by name**, in the rail and the repository picker. They used to reorder by recent activity, so starting a conversation moved the project you were in to the top and shifted everything under your cursor.

### Fixed

- **A new conversation appears in the rail straight away.** The project moved to the top but gained no row, and only closing and reopening it made the conversation show up.
- **New session is never disabled.** While the app was switching projects, every **+** in the rail greyed out at once — and on a switch that opens no conversation it stayed that way.
- **"+" on another project starts the conversation there**, rather than switching and leaving you on whatever was already open.

## 3.2.3 — 2026-08-07

### Fixed

- **Grok Build Desktop opens on macOS.** Earlier builds were refused outright — *"Grok Build Desktop is damaged and can't be opened"* — because the app carried no signature at all, which Apple silicon will not load. It is now ad-hoc signed, so macOS asks whether to open it (*right-click → Open*, or *Privacy & Security → Open Anyway*) instead of telling you to bin it. Still not notarised; a certificate is on the way. If you already downloaded an earlier build, `xattr -dr com.apple.quarantine "/Applications/Grok Build Desktop.app"` recovers it.

## 3.2.2 — 2026-08-07

### Fixed

- **The Marketplace and Open VSX listing shows its screenshot again.** A screenshot removed in 3.2.1 was still referenced by the store page, which renders from its own copy of the README, so the listing showed alt text where the picture should be.

## 3.2.1 — 2026-08-07

### Fixed

- **The projects rail lists other projects' conversations from a phone again.** It said *"Update Grok Build to preview"* against a host that was fully up to date and had already answered — the reply was dropped on the way out because it described a project other than the one that browser tab was working in, which is exactly what the rail asks about.
- **Grok Build Desktop wears its own icon on Windows.** The Start menu, the taskbar and Task Manager showed Electron's default: the packaging step that stamps the icon and version details onto the app had been switched off. The installer wizard carries the mark now too.

## 3.2.0 — 2026-08-07

### Added

- **Grok Build Desktop (Community) — a standalone app for Windows and macOS.** The same coding agent, without an editor or a terminal in front of it: open a folder and start. Projects on the left, the conversation in the middle, your files on the right. The builds are **not code-signed yet** — Windows SmartScreen and macOS Gatekeeper will warn you the first time. [Download](https://afkpilot.com/desktop).
- **The desktop file panel edits text files, in tabs.** Several files open at once, each with its own unsaved-changes dot. Markdown opens as a preview with a source toggle, `Ctrl`/`Cmd+S` saves, **Cancel changes** reverts, and closing a tab with unsaved edits asks first. If the agent changed the file underneath you, the save is refused and you choose: reload its version, or keep yours. Silently winning that race in either direction is how people lose work.
- **The app tells you when a new version exists.** It checks on start and every twelve hours, and shows how to update. It does not install anything behind your back — and it cannot on macOS anyway, since an unsigned app can't be replaced automatically.
- **Add project folders from the rail.** A `+` on the PROJECTS heading, and the empty rail offers it too.
- **A project that turns off permission prompts now asks you first.** A repository can ship a `.grok/config.toml` setting `permission_mode = "always-approve"`, and it overrides your own setting — so cloning someone's code was enough to remove every prompt between the agent and your machine. Opening such a project now says so and waits for you. Your own global setting is unaffected and stays silent.

### Changed

- **"Continue in a new chat" moved to the conversation's `⋯` menu**, beside Rename and Delete — the things you do *to* a conversation. The composer's settings keep model and effort, which is what they are for. Worktree apply and remove moved with it.
- **The file tree and the projects rail can be resized** by dragging their edge, on desktop and in the browser.

### Fixed

- **File icons are visible in dark themes.** Around thirty file types drew almost black on a dark background, so `.dockerignore` and friends were nearly invisible.
- **Markdown files render properly in the desktop panel** — lists, tables and the rest, using the same renderer the conversation uses, rather than a reduced one that handled only links and headings.
- **The settings button under the composer opens settings on the first click** when the gear menu is already open, instead of only focusing the composer.
- **A phone's project drawer is full width again.** It had collapsed to about 150px in AFK Pilot.
- **Closing a project folder asks first when something is still running.** It ends every conversation in that folder and stops the agent, which discarded a turn in progress with no warning.
- **`--config-json` applies to one run.** It was merged into your real configuration and left there, so a throwaway setting passed once kept applying on every later launch, with nothing on screen explaining why.
- **Files in one project can no longer be opened from a conversation in another.** Having both projects open was treated as permission to reach either from either.
- **Markdown with Windows line endings renders properly.** Headings kept their `#` and bullets kept their `-`, while tables and links worked — so it looked like the renderer was mostly fine when the document's structure was actually gone. Affected chat messages too, not just the file panel.
- **A file saved after you switch projects goes to the file you opened**, not to a same-named file in the project you switched to.
- **Selecting a project no longer opens a conversation in it.** It shows you what is there; you choose what to open.
- **The `⋯` menus close when you click them again.**

## 3.1.0 — 2026-08-06

### Added

- **The panel says which conversation you are in.** The name sits at the top, the same one the history list shows, with the full text in a tooltip when it is too long to fit. Renaming happens there too: hover it and a pencil appears, or tap the name on a phone. Enter or clicking away saves, Escape cancels — no trip through the history list or the `⋯` menu.

### Changed

- **Conversation names, pinned and archived projects now live in `~/.grok/client-state/`** instead of inside VS Code. Nothing changes for you — your existing names, pins and archives move across on first launch and keep working — but they are now readable files rather than editor-private storage, so they can follow you to other Grok clients on the same machine. One visible consequence if you use **multiple VS Code profiles**: those profiles previously kept separate names and pins, and now share one set.

### Fixed

- **A question from Grok always offers a free-text answer** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)). "Other" only appeared when Grok itself supplied that choice, which it usually doesn't — so there was no way to answer anything the listed options didn't cover.
- **A long command no longer swallows the chat** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71), [#92](https://github.com/phuryn/grok-build-vscode/issues/92)). The six-line limit counted line breaks rather than the lines you actually see, so a few very long lines filled the bubble regardless — and the permission card showed the whole command with no limit at all. Both are bounded by what is drawn now, with **View all** for the rest, and nothing gained a scrollbar of its own.
- **"View all" opens a command in its own language** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A Python command was always opened as a shell script; VS Code detects it now.
- **"Scroll to bottom" stops reappearing while you are already at the bottom** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)). Tool details growing above the view made the browser adjust the scroll position itself, which read as though you had scrolled away — the more the UI is scaled up, the more often it happened.
- **An unsent draft no longer gains a copy of itself** every time you leave a conversation and come back. Pulling a message back to the composer with **Edit** was recorded as part of the conversation, so re-opening it did the same thing again — and again.
- **The project you are working in can be folded** in AFK Pilot's project rail. It was held open so a fold could never hide where you are; now it re-opens only when a conversation actually moves into it, so folding the one you are in sticks.
- **Rewind no longer states a file count it can't stand behind.** The CLI can report a file it created but left on disk, so the message says what was rolled back and warns that anything created after that point may remain.
- **The panel wastes less width in VS Code.** The gutter that suits a browser tab is a visible slice of a narrow sidebar, so the desk gets its own — and the conversation's name lines up with the messages under it.
- **"Scroll to bottom" stops going see-through when you hover it.** It borrowed a colour themes intend as a tint over a toolbar, not as a background of its own, so on many themes the conversation showed through the button.
- **`Expand tool details` is documented as it behaves.** It has opened tool groups since 1.5.10; the README and the setting description still described the older behaviour.

## 3.0.1 — 2026-08-05

### Fixed

- **History filled up with "Untitled" conversations that would not open.** Sessions you never typed into were being left on disk — one for every window you opened on a project and closed again without asking anything. Nothing removed them, and some the CLI cannot load at all, so clicking one appeared to do nothing. They are cleaned up now, at startup and whenever you start or open a conversation. Anything you renamed, pinned, or actually used is left alone. ([#97](https://github.com/phuryn/grok-build-vscode/issues/97))
- **A conversation you have not renamed now shows the title Grok gave it** — the same one `grok sessions list` shows — instead of the first 50 characters of whatever you happened to type first. Your own renames still win, and names you have already given are untouched. ([#96](https://github.com/phuryn/grok-build-vscode/issues/96))

## 3.0.0 — 2026-08-05

### Added

- **A projects rail in AFK Pilot.** Every project with Grok history down the left, each showing its newest conversations, with your pinned conversations lifted above them across all projects and a search that filters both. You can start a new session in any project without switching to it first, and rename, delete or clear history from the row itself. On a phone it is a drawer behind the handle in the header.
- **Archived projects.** Put a project away from its `⋯` menu, and anything untouched for 30 days goes there on its own — into a folded section that stays out of your way. Nothing is lost: an archived project still works, and starting or continuing a conversation in one brings it back. The three most recent projects are never archived automatically, so the list can't empty itself out.
- **You can delete the conversation you have open**, in VS Code and in AFK Pilot. It closes and a new one starts in the same project.

### Changed

- **AFK Pilot's toolbar moved into the conversation.** The header names the conversation and its project, with Session history and New session beside it; the project controls live in the rail instead. Projects are ordered by their newest conversation rather than by when their folder was last written to, so clearing a project's history no longer moves it to the top.

### Fixed

- **A conversation could be wedged shut by a Stop that never landed.** If the CLI ignored a stop request, the turn never ended, and from then on every message you sent turned into a queued message that could never be sent — only reloading the window cured it. A stop that goes unanswered for ten seconds now restarts the CLI, keeping the conversation, rather than leaving it stuck.
- **A message sent while Grok was working appeared twice**, once as your bubble and once as the queued block.
- **Renaming, deleting and clearing history now work in a project you have not switched to**, instead of being refused — and clearing another project's history shows the result there rather than writing a line into whatever conversation you happen to be reading.

---

## 2.3.1 — 2026-08-02

### Changed

- **Dictation inserts where your cursor is** instead of always appending to the end, and replaces the text you had selected — so you can pause, correct a sentence in the middle, and carry on in place. Authored by [@tarcisiomiranda](https://github.com/tarcisiomiranda) in [#72](https://github.com/phuryn/grok-build-vscode/pull/72), co-authored here; it was ported onto the current voice transport rather than merged, because the branch predated the shared-PCM rewrite.
- **Clicking Send or Queue now turns the microphone off** and sends exactly the text you can see. A transcript still in flight can no longer refill the composer you just cleared. Saying **"grok send"** still submits hands-free and keeps listening — that flow is unchanged on purpose.

### Fixed

- **Dictation could wipe a draft you had already typed.** The composer position was only remembered when the extension believed voice was configured, but recording is the host's call — so when the two disagreed, the first words transcribed replaced everything in the box.

---

## 2.3.0 — 2026-08-01

### Added

- **You can see what you attached** ([#88](https://github.com/phuryn/grok-build-vscode/issues/88)). Images preview as thumbnails in the composer and in the conversation itself, in VS Code and in AFK Pilot, live and after a restore. Click or tap one to open it full size — on a phone that version is fetched on demand, so it arrives a moment after the preview instead of being carried around with every conversation. Photos work, not just screenshots: JPEG is decoded and downscaled on your own machine.
- **What a conversation cost.** A running total per conversation, taken from what the CLI reports and shown only when the whole conversation can be accounted for — a partial figure is worse than none.
- **AFK Pilot can read a shorter, speech-friendly version of each reply** ([#94](https://github.com/phuryn/grok-build-vscode/issues/94)), matching the switch VS Code already had. Each browser keeps its own preference.

### Changed

- **"Summarize before speaking" is now "Read simplified summaries", and defaults on.** The setting key is unchanged. If the summary fails or never arrives, the original reply is spoken rather than nothing.
- **Switching repository lands somewhere predictable** — that repository's newest conversation, or a new one if it has none — and says "Loading conversation" while it does, with the switcher held until it finishes.

### Fixed

- **Opening an older conversation from history no longer re-types itself** ([#93](https://github.com/phuryn/grok-build-vscode/issues/93)). It arrives in one update, as a reconnect already did.
- **The scrollbar reaches the bottom with "Expand tool detail" on** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)), and a clipped command can be revealed by tapping on a touch screen.
- **A phone no longer bounces between two repositories.** Reconnecting — which happens every time a phone tab goes to the background — re-asserted a repository that disagreed with the conversation it then restored, so the view flipped back and forth.
- **An attachment can no longer arrive in the wrong conversation.** If a phone reconnected while an image was still being written to disk, that image could land in whichever conversation VS Code happened to be showing.
- **Reading replies aloud no longer stops after switching conversation** on a phone.

---

## 2.2.0 — 2026-07-31

### Changed

- **Plan mode now uses the CLI's own approve/reject, instead of a workaround.** Older Grok Build CLIs treated *any* answer to a plan card as approval, so the extension shipped a hidden instruction message teaching the model to read your real verdict from a follow-up, and cancelled the planning turn to re-drive the work itself. The CLI fixed that, so all of it is gone. **Approve & implement** now continues straight into the work in the same turn rather than starting a second one, and **Keep planning** leaves Grok planning — sometimes it revises immediately, sometimes it waits for you to say what to change. A comment you attach to a verdict still reaches Grok *before* it starts implementing.
- **Plan mode needs Grok Build CLI 0.2.117 or newer.** Updating the extension updates the CLI on your next session. If it can't be updated — or its version can't be read — Plan is shown disabled with the reason, while Agent and Auto-accept carry on working. That's deliberate: the verdict handling above isn't safe on an older CLI.

### Fixed

- **A conversation opened on your phone no longer re-types itself.** Mobile browsers discard a backgrounded tab, so coming back to AFK Pilot rebuilt the conversation one message at a time. It now arrives in a single update, showing your recent exchanges. Opening an *older* session from the history list still streams — that one is next.
- **Grok Build CLI installs that resolve to a `grok.cmd` shim** (common on Windows) failed the version read, which in turn disabled Plan mode.
- **Conversations recorded by earlier versions still restore cleanly.** They contain the old hidden instruction message; it stays hidden, and plan cards stay where they belong.

---

## 2.1.1 — 2026-07-31

### Added

- **Custom voice keyterms** ([#73](https://github.com/phuryn/grok-build-vscode/issues/73)). `grok.voiceKeyterms` biases dictation toward your own vocabulary — cmdlets, hooks, internal package names — with User and Workspace scope. `grok.voiceLanguage` additionally formats spoken numbers, currencies and units.

### Fixed

- **Plan mode no longer refuses harmless exploration** ([#89](https://github.com/phuryn/grok-build-vscode/issues/89), [#91](https://github.com/phuryn/grok-build-vscode/issues/91)). Inspection commands — `file`, `ls`, `sips -g`, `git log … 2>$null`, read-only PowerShell conditionals — run while planning again, and answering a question card no longer reports "approve the plan first".
- **Security: plan mode could be bypassed, letting an agent change your workspace before you approved a plan.** Three routes: a parenthesised subexpression behind an allowlisted command (`echo (Set-Content …)`), agent-supplied environment overrides (`NODE_OPTIONS` on the allowlisted `node --version`), and a plan-file exemption that let any mutating command ride along with a plan write. Affects earlier releases — update when convenient.
- **Resumed conversations showed the time you opened them** ([#87](https://github.com/phuryn/grok-build-vscode/issues/87)) rather than when the messages were written.
- **A device revoked from the web left VS Code claiming it was still linked**, with no route out of the state. It now unlinks itself and offers to link again.
- **A prompt queued from a phone could be lost** when the send that consumed it failed — it is now kept and retried once the problem is cleared.

### Changed

- The device commands are now **AFK Pilot: Link this device** and **AFK Pilot: Unlink this device**, matching the product name.
- "Summarize before speaking" follows "Read replies aloud": switched off and disabled while replies aren't being spoken, so it can't silently bill an API call later.

---

## 2.1.0 — 2026-07-30

### Added

- **Voice input from AFK Pilot.** Dictate on your phone: the audio streams to your machine, which transcribes it with xAI speech-to-text and puts the text in the composer. End with "grok send" to submit hands-free.
- **Every browser tab is its own conversation, with its own repository.** Open several tabs against one linked machine, pick a different repo in each, and they stay independent across reloads, reconnects and phone tab-discards.
- **The same conversation can be open in VS Code and the browser at once**, live in both — start at the desk, carry on from the phone, switch back whenever. A tab that arrives with nothing of its own now continues what the desk is showing, instead of opening an empty session.
- **"Continue remotely" is one tap** from the chat toolbar on a linked machine, and *Add document*/*Add photo* now sit behind a phone-friendly picker.
- **"Other" answers take free text** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)), macOS gets Emacs-style `Ctrl+F`/`Ctrl+P` composer navigation ([#84](https://github.com/phuryn/grok-build-vscode/issues/84)), and a still-processing sound cue plus an opt-in "summarize before speaking" join the audio settings ([#78](https://github.com/phuryn/grok-build-vscode/issues/78)).

### Fixed

- **Security: a linked remote device could delete directories outside the session store.** A crafted session id (e.g. `../..`) passed through `deleteSession` without validation, so a remote client could recursively remove paths outside `~/.grok`. Session ids are now validated at the wire boundary *and* again before any filesystem operation. Affects earlier releases with Remote Control linked — update when convenient.
- **Expanding a Thinking block could land your click on "No, and tell Grok…"** ([#76](https://github.com/phuryn/grok-build-vscode/issues/76)) — the permission card's scroll no longer moves the buttons out from under the pointer.
- **Messages sent from a phone appear immediately** instead of vanishing until the round trip completes, which on a weak connection made a send look lost.
- **The gear no longer offers "Sign in (link this device)" before it knows the answer** — an already-linked machine could be invited to re-link itself during startup.

---

## 2.0.10 — 2026-07-27

### Added

- **Read completed replies aloud.** A new toggle (gear → Config & debug) speaks each finished reply via speech synthesis, skipping code blocks — separate on/off state for VS Code and for AFK Pilot.

### Fixed

- **AFK Pilot's text size no longer follows VS Code's own chat zoom.** The two are meant to be fully independent; changing the desktop zoom while a device was linked could silently affect AFK Pilot's own scale too.
- **Picking a different repository from AFK Pilot could get stuck showing the old one.** A live, not-yet-saved-to-disk session from whichever repository you'd been in could leak into the newly selected repository's history and be mistaken for "already open," so the screen sometimes never switched over.

---

## 2.0.9 — 2026-07-27

### Added

- **Attach documents from AFK Pilot.** The remote **+** picker gains *Add document* next to *Add photo* — `.md`, `.txt`, `.pdf`, `.csv`, `.xlsx`, and `.docx` (up to 20 MiB) attach as an explicit path chip, exactly like a local drag-and-drop, so Grok reads the file with its own tools. Linked devices on an older release simply don't see the option.

### Fixed

- **Security: a linked remote device could reference files outside your workspace via an `@`-mention.** Selecting a mention result resolved the picked path by joining it to the workspace root with no containment check, so a crafted path from a remote client could point outside the workspace and have its contents attached to the next message. Remote mentions are now resolved exclusively against the host's own indexed file catalog — the same list the autocomplete popup offered — never against an arbitrary path. Present since `@`-mention shipped (v1.7.5); if you use Remote Control (AFK Pilot), update when convenient.

---

## 2.0.8 — 2026-07-26

### Fixed

- **Long command output and diffs no longer scroll inside a small box** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A command's captured output and an edit's inline diff now show a short preview that grows **inline** — *View all* / *Show more* — so the page scrolls normally instead of trapping you in a nested scrollbar. On a linked device, where there's no editor to open the full text, both expand in place.
- **Permission-card keyboard polish** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): the option with keyboard focus now shows a clear outline, and answering a card returns focus to the composer.

---

## 2.0.7 — 2026-07-26

### Fixed

- **Switching repository from your phone no longer changes what VS Code shows.** The choice is shared across your remote devices on purpose — that's the point of it — but VS Code has no repository picker, so it now stays on the workspace you have open: its history list keeps showing that project's sessions, and *New session* starts there. Previously a phone switching projects silently re-scoped the list and pointed *New session* at a different checkout.

---

## 2.0.6 — 2026-07-26

### Fixed

- **Worktree sessions are back in their repository's history** ([2.0.5](#205--2026-07-26) regression). They were matched to their parent by comparing the repository's *git root* against the folder open in VS Code — the same path in the usual case, but not when you open a *subdirectory* of a repository, and then those sessions vanished from the list. The parent repository now lists every worktree session again, as it did before 2.0.5.
- **A worktree opened directly as your workspace is now a repository in its own right.** It was excluded from the picker as "not a repository you choose between", which left *Clear all history* pointing at an entry that wasn't in the list — so it silently did nothing after you confirmed it.

---

## 2.0.5 — 2026-07-26

### Added

- **Switch repositories from a linked AFK Pilot device.** The chat header on the web client gains a repo chip listing every project Grok has sessions for — pick one to browse its history, pin the ones you reach for, then *New session* to start Grok there. A project's worktrees come with it instead of appearing as separate entries. The chip is remote-only: in VS Code the window already *is* the repository.

### Fixed

- **Re-linking a machine no longer costs you a device slot.** Linking was tracked per link rather than per machine, so re-pairing after a reinstall or a failed connection added a *second* device and could push you past your device limit — for hardware you already had. A re-link now supersedes that machine's previous entry.

---

## 2.0.4 — 2026-07-26

### Fixed

- **The native diff editor shows the whole file**, opened on the first changed line, instead of a context-free preview of only the replaced lines ([#66](https://github.com/phuryn/grok-build-vscode/issues/66)). Grok never sends the file itself, so both sides are reconstructed from the copy on disk plus its per-site line metadata — anchored per site, so a repeated token can't become a phantom change. An unreadable, oversized, or since-modified file falls back to the previous region-only diff. Thanks to [@padixa](https://github.com/padixa) for the report and the follow-up that scoped it.

---

## 2.0.3 — 2026-07-26

### Added

- **Edit a sent message** — hover your latest message → *Edit*. It removes that turn (restoring any files it changed) and puts the text back in the composer so you can fix it and send again. The exact complement of Rewind, which is offered on every earlier message. ([#56](https://github.com/phuryn/grok-build-vscode/issues/56))
- **Rewind now returns the message's text to the composer** too — it always deleted that message, so it no longer discards what you wrote.
- **Keyboard on permission cards** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): *Allow once* is ordered first and takes focus when the composer is idle, so Enter approves. Arrows move between options, Escape returns to the composer without answering, and typing any character jumps to the composer instead of pressing a button. A keystroke never selects *Allow always*.

### Fixed

- **Turning off the active-file context chip is now remembered** ([#67](https://github.com/phuryn/grok-build-vscode/issues/67)). The chip is rebuilt whenever you switch files, which silently re-enabled it — so dismissing it was futile. The eye-off choice now persists across file switches and restarts.
- **Rewind discarded one turn too many.** Grok's rewind removes the message it targets, not just what follows; the confirmation said the opposite. Both the wording and the targeting are corrected, so Rewind and Edit now remove exactly the turns they name.
- **Rewind left stale plan and permission cards behind.** Those cards are stored by the extension, not by Grok, so rewinding the conversation stranded the ones belonging to deleted turns — they reappeared at the bottom of the restored chat. Both actions now drop them.
- **Plan snapshot files no longer pile up.** Reopening a session re-wrote a fresh copy of every saved plan, so one session accumulated 13 identical files. Snapshots are now named by their content and reused, and a session's snapshots are deleted with the session.
- **Rewinding now refunds the discarded turns' tokens.** The session billing total counted turns that no longer exist. Usage is recorded per turn, so the total is recomputed from what survives. (Sessions from before this change keep their existing total — there's nothing stored to subtract.)
- **Rewind and Edit no longer reload the conversation.** They deleted the whole chat, showed the welcome screen and re-rendered every message; now only the removed turns disappear.
- **Confirmations for Rewind/Edit are now in-chat**, like every other destructive confirm — no native VS Code modal.
- **No confirmation dialog unless code will be reverted.** A conversation-only rewind or edit just happens — the message goes straight back to the composer. Turns that changed files on disk still ask, since that part cannot be undone.
- **Steered messages no longer break Rewind and Edit.** A message sent mid-turn isn't a separate prompt and has no restore point; counting it shifted every later message by one, so Rewind targeted the wrong turn (reverting the wrong files) and Edit failed. Steered messages are now excluded and offer neither action.

### Changed

- Gear → Remote Control: *Your AFK Pilot account* → *Your account*.

---

## 2.0.2 — 2026-07-25

### Fixed

- **Files missing from the composer's `@` autocomplete** in large workspaces ([#69](https://github.com/phuryn/grok-build-vscode/issues/69)). The file index was capped at 5000 entries, and past that cap VS Code returns an arbitrary subset — so real source files could be absent while less relevant ones still showed. Any file open as a tab is now always mentionable, and the new `grok.mentionIndexLimit` setting raises the cap for big repos. Thanks to [@datvm](https://github.com/datvm) for the diagnosis and the fix ([#70](https://github.com/phuryn/grok-build-vscode/pull/70)).

---

## 2.0.1 — 2026-07-25

### Added

- **Keep this machine awake while an [AFK Pilot](https://afkpilot.com) device is linked**, so a turn you started from your phone isn't cut off by idle sleep — `caffeinate` on macOS, `SetThreadExecutionState` on Windows, `systemd-inhibit` on Linux. Only system sleep is blocked (the display still sleeps), the lock is released the moment you sign out, and it never survives closing VS Code. Turn it off with `grok.remote.keepAwake`. A closed laptop lid still suspends on every OS.

---

## 2.0.0 — 2026-07-25

The extension pairs with **[AFK Pilot](https://afkpilot.com)** — a companion web client that brings your Grok sessions to your phone or any browser — and moves to a Fair Source license.

### Added

- **Remote control via [AFK Pilot](https://afkpilot.com)** — gear → *Remote Control* → **Sign in (link this device)** pairs this machine with the AFK Pilot web client: follow running turns, approve permissions, answer questions, and send or steer messages from a phone or any browser while away from your desk. The extension dials out to the service (no inbound port); **Sign out** unlinks the device here and revokes it on your account. The experimental `grok.remoteControl.relayUrl` setting is gone — pairing is one click now.
- **Touch-ready chat UI** — real tap targets on touch screens, always-visible actions on history rows / images / equations / diagrams (previously hover-only), roomier question and permission cards, and in-browser PNG download for generated images, math, and Mermaid diagrams. A resize (e.g. the mobile keyboard collapsing) no longer yanks the chat to the bottom.
- ` ```math ` / ` ```latex ` / ` ```tex ` code fences render as display equations, like ` ```mermaid ` already did for diagrams.

### Changed

- **License: MIT → FSL-1.1-MIT (Fair Source).** Free to use, modify, and redistribute for any purpose except a competing commercial product or service; each release automatically becomes plain **MIT two years after publication**. Versions up to and including 1.8.1 were published under MIT and remain MIT. ([LICENSE](../LICENSE))
- **Destructive confirmations are now in-chat dialogs** (delete session, clear all history, apply/remove worktree, remote sign-out) instead of native VS Code modals, so they behave identically in the sidebar and the AFK Pilot browser client.
- Card titles render in the UI font instead of the editor's monospace.

## 1.8.1 — 2026-07-24

### Changed

- **The reasoning-effort picker now matches the active model.** The gear's effort dots offer exactly the current model's advertised levels — grok-4.5 shows *low / medium / high* — instead of a fixed six-level ladder. A model that advertises no menu falls back to the full ladder, so nothing regresses.

## 1.8.0 — 2026-07-24

Two contributor features from [@funkpopo](https://github.com/funkpopo) ([#65](https://github.com/phuryn/grok-build-vscode/pull/65)), cherry-picked and verified end-to-end against real grok. Both need a recent Grok Build CLI (0.2.111+); older CLIs degrade gracefully.

### Added

- **Worktree sessions** — *Grok: New Worktree Session* (gear → *New worktree session*, or the Command Palette) runs a session in an **isolated git worktree** under `~/.grok/worktrees/`, so agent edits don't touch your main checkout until you **Apply worktree** (merge back); **Remove worktree** discards the isolated checkout. History rows show a `WT <label>` badge and reopen with the right cwd.
- **Rewind** — hover a message you sent → **Rewind** (or *Grok: Rewind Conversation*) to roll the conversation back: it truncates the chat and, on confirm, restores the files Grok changed since that point (a safety prompt shows first, because it can revert code on disk).
- **Deep Research / Workflow progress** — a live progress card with **Pause / Resume / Stop** for long autonomous runs, so they stay visible and interruptible.

## 1.7.5 — 2026-07-24

### Added

- **`@` file autocomplete in the composer** — type `@` to fuzzy-search workspace files and attach one as a chip (keyboard-navigable; the pick keeps both the `@path` text and a real chip). Thanks to [@funkpopo](https://github.com/funkpopo) ([#63](https://github.com/phuryn/grok-build-vscode/pull/63); closes [#60](https://github.com/phuryn/grok-build-vscode/issues/60)).
- **Sound notifications** — an optional short tone when Grok finishes a turn or hits an error, played *only when the Grok panel isn't focused* (a rising chime for done, a lower tone for errors). Off by default; toggle in gear → *Config & debug → Sound notifications* (`grok.soundNotifications`). ([#59](https://github.com/phuryn/grok-build-vscode/issues/59))

### Changed

- **Switch to Auto accept mid-turn** — the mode picker stays live during a running turn, so you can stop approving permission cards without stopping Grok; flipping to Auto accept also clears any card already on screen. Approving a plan now returns you to your pre-plan mode (Auto accept stays Auto accept). ([#64](https://github.com/phuryn/grok-build-vscode/issues/64))
- The waiting indicator (*Grokking* / *Thinking…*) now shimmers while idle. Thanks to [@funkpopo](https://github.com/funkpopo) ([#63](https://github.com/phuryn/grok-build-vscode/pull/63)).

### Fixed

- **Plan mode no longer blocks Grok from writing its own `plan.md`.** On Windows, Grok sometimes persists its plan via a PowerShell `Set-Content` command instead of the file-write tool; the plan-gate was refusing it ("Plan mode blocked a command…") and Grok had to retry. That write lands outside your workspace, so it's now allowed — while any command that also reaches into the workspace stays blocked. ([src/plan-gate.ts](../src/plan-gate.ts))

## 1.7.4 — 2026-07-19

Eleven long-standing bugs found by running this extension through a multi-model bug-finding benchmark, then re-verified and fixed against the live tree — most of them Windows path handling. 42 new regression tests.

### Fixed

- **Windows path family:** drag-and-drop into the chat works on Windows (the dropped `file:///C:/…` URI was mis-stripped to `/C:/…` and silently failed); absolute Windows paths like `C:\work\file.ts` (with or without `:42`) now linkify in chat — and clicking any `path:line` ref now actually opens at that line; agent-sent `file://` media refs convert via a proper URI→path helper (drive letters + UNC hosts); session history now reads the same `~/.grok` the CLI writes (`GROK_HOME` override honored, USERPROFILE-first on Windows — a set `HOME`, e.g. git-bash, used to split them). ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js), [src/file-ref.ts](../src/file-ref.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sessions.ts](../src/sessions.ts), [src/sidebar.ts](../src/sidebar.ts))
- **Crash recovery:** after the CLI process dies, the next send respawns and resumes the same session instead of writing into the dead client (which errored, or hung at "Grokking…", until you manually started a new session); a `taskkill` that runs-but-fails (Access Denied) no longer leaves the agent's `wait_for_exit` pending forever — a direct signal fallback fires; an error or exit during the startup lock can no longer strand the composer's locked state. ([src/sidebar.ts](../src/sidebar.ts), [src/terminal-manager.ts](../src/terminal-manager.ts), [media/chat.js](../media/chat.js))
- **Smaller correctness fixes:** full-line selections no longer attach one phantom line past the selection (VS Code selection ends are exclusive at column 0); Command Palette *New Session* clears the previous transcript like the toolbar button; the per-session webview reset clears the question/restored-card maps (a new session's tool updates could mutate the previous session's cards); generated media in a `..`-prefixed dir under grok home serves from disk instead of falling back to base64; the STT keyterm list enforces its documented 100-term cap. ([src/chips.ts](../src/chips.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [src/sessions.ts](../src/sessions.ts), [src/voice.ts](../src/voice.ts))

## 1.7.3 — 2026-07-18

### Fixed

- **A missing Grok Build subscription/entitlement no longer traps you on the sign-in screen.** The backend's 403 *"requires a Grok subscription"* (which sign-in can't fix — the CLI even ignores your `XAI_API_KEY` while a cached OAuth session exists) now shows a clear in-chat "Not a sign-in issue" notice carrying the CLI's own advice, instead of the auth overlay. Only a genuine credential failure (ACP `-32000`, or unambiguous credential wording) opens the sign-in screen. ([#58](https://github.com/phuryn/grok-build-vscode/issues/58); [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts))
- **The "Grokking" indicator no longer sticks forever when auth recovery ends on the sign-in screen** — the failed turn now closes properly (error state, busy cleared), and a stale sign-in overlay can't resurrect when switching back to the session. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))
- The sign-in screen now warns that a cached sign-in shadows `XAI_API_KEY` (`grok logout` to use the key). ([media/chat.js](../media/chat.js))

## 1.7.2 — 2026-07-18

### Fixed

- **Hitting your usage/weekly limit no longer looks like a sign-in problem.** A rate-limited turn (ACP error `-32003`, or the CLI's limit phrasings) now shows a clear "Usage limit reached — not a sign-in issue" notice carrying the CLI's own message. Before, the limit's billing-flavored wording tripped the expired-token recovery, whose retry ended on the login screen. No reset date is shown because the CLI/backend never provides one. ([#57](https://github.com/phuryn/grok-build-vscode/issues/57); [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.7.1 — 2026-07-18

### Changed

- **README reworked as a landing page.** Features now sit directly under *Why use this?*, descriptions are trimmed to the point (deep technical detail stays in the dedicated docs), and the duplicate *Cost control* / *Context & cost* sections are merged into one. Fresh screenshots for **Context & cost**, **Fork conversation**, and **Queue or steer**, plus a new **Subagents** feature entry; the *Agent Dashboard* section folded into *Session history*, which now hosts the status-dot legend.
- **Smaller vsix** (~4 MB less): four unused screenshots removed and the `/imagine` hero image converted to WebP (2.9 MB → 240 KB).

## 1.7.0 — 2026-07-17

Three requested features, all built on ACP surfaces the Grok Build CLI already ships but never advertises — probe-confirmed against grok 0.2.101 first ([research/grok-build-oss-findings.md](../research/grok-build-oss-findings.md) § 3a) and pinned by new real-grok gates.

### Added

- **Steer — redirect Grok mid-turn without interrupting it.** A message sent while Grok works still queues by default; now the pending message carries a **Steer** button that sends it straight into the running turn, so Grok changes course mid-answer. It is not a Stop: the turn keeps its in-flight tool work and finishes normally. **Steer by default** (gear → *Config & debug*, off by default) makes send-while-busy skip the queue entirely; steered text is plain text only (no chips, editor context, or `/commands`), and a CLI that can't steer falls back to queueing rather than losing the message. ([#52](https://github.com/phuryn/grok-build-vscode/issues/52); [src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **Fork conversation** (gear → *Fork conversation*) — branch the conversation into a new session named `(Fork) <original>`, leaving the original byte-for-byte unchanged in your history. It branches the conversation, **not your code**: files on disk are untouched. ([#48](https://github.com/phuryn/grok-build-vscode/issues/48); [src/acp.ts](../src/acp.ts), [src/sessions.ts](../src/sessions.ts), [src/sidebar.ts](../src/sidebar.ts))
- **Token usage in the context popover.** Click the donut for a **Session total** of what the conversation has billed (input / cache read / output), tracked across every turn, plus a collapsible **Last turn** with the same split and its **model calls** — the number that explains why a turn bills far more than the context it holds. Cache *read* is shown; no cache-*creation* figure exists anywhere in the CLI, so it is omitted rather than faked as zero. ([#53](https://github.com/phuryn/grok-build-vscode/issues/53); [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Changed

- **Compact conversation moved from the gear menu to the context popover** — it is a context action, so it now sits next to the number that tells you when you need it (disabled at 0 tokens). The gear's Session section holds *Fork conversation*. ([media/chat.js](../media/chat.js))
- **Usage telemetry adds three feature flags** (`showThinking` / `expandToolDetails` / `steerByDefault`) **and the host app** (VS Code / Cursor / …), so we can see whether our defaults are the ones people keep and which VS Code forks are worth supporting. Still anonymous, one event per session, no content — every field is listed in [docs/privacy.md](privacy.md). ([src/telemetry.ts](../src/telemetry.ts))

### Fixed

- **The buttons on a pending message no longer miss while Grok is streaming.** Steer / Edit / Remove act on press instead of click: the pending block sits at the end of the chat, which re-scrolls on every streamed chunk, so the button moved out from under the cursor mid-click. ([media/chat.js](../media/chat.js))

## 1.6.2 — 2026-07-16

### Fixed

- **A default model that isn't available no longer nags you.** When `grok.defaultModel` points at a model the session's agent can't use (e.g. a Composer model on a grok-build session, or a retired id), Grok already falls back to an available model — the extension now does so silently and heals the setting to that working model, instead of popping a warning telling you to change it. An empty default (the shipped value = CLI default) is left untouched. ([src/sidebar.ts](../src/sidebar.ts))

### Changed

- **Usage telemetry now reports only from the official build.** The anonymous `session_start` event is gated on the official extension id, so a fork republished under a different publisher never reports into this project's analytics. (Unchanged otherwise: anonymous, one event per session, no content, double-gated on VS Code's global telemetry setting + `grok.telemetry.enabled`.) ([src/telemetry.ts](../src/telemetry.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.6.1 — 2026-07-16

Groundwork: Grok Build CLI went **open source** ([xai-org/grok-build](https://github.com/xai-org/grok-build)). We source-verified every item in our upstream feedback and probed the shipped **grok 0.2.101** binary to confirm which newly-visible ACP surfaces actually ship (`research/oss-surfaces-probe.cjs`, `research/grok-build-oss-findings.md`).

### Added

- **Voice input now works without a separate API key.** If you're signed in with `grok login`, the extension reuses that stored token (`~/.grok/auth.json`) for Speech-to-Text — no need to obtain and paste a dedicated console.x.ai key. A dedicated key (`grok.voiceApiKey` / `GROK_VOICE_API_KEY` / `XAI_API_KEY`) still takes precedence; only xAI-issued, non-expired tokens are used, and streaming auth failures now give re-login/key guidance instead of a raw error. The transmission (audio + credential to xAI's STT endpoint) is disclosed in [docs/privacy.md](privacy.md), and setup/costs moved to [docs/voice-setup.md](voice-setup.md). ([#51](https://github.com/PawelHuryn/grok-vscode/issues/51); [src/voice.ts](../src/voice.ts), [src/voice-streamer.ts](../src/voice-streamer.ts), [src/sidebar.ts](../src/sidebar.ts))
- **Subagent rows now show real duration and output.** A subagent's completion (`duration_ms`, `tokens_used`, the child's output) rides a live notification the CLI already sends (`_x.ai/session_notification` → `subagent_finished`); we now consume it, so a delegation card fills in its timing and result even for the Composer agent, whose tool-channel completion carries no duration. A failed or cancelled subagent now shows its status and error (flagged red on the row) instead of a silent, empty "success," and the card carries a distinct bot icon. ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Automatic (context-full) compaction now shows a one-line notice in chat** — "Auto-compacting context (N% full)…" (and "Compaction failed." on failure) — where it used to happen silently. A manual `/compact` keeps its "Compacted." confirmation. ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Changed

- **The context donut refreshes instantly after `/compact` — and now after automatic (context-full) compaction too.** The fresh post-compact token count rides a live notification the CLI already sends (`_x.ai/session_notification` → `auto_compact_completed.tokens_after`), confirmed on grok 0.2.101; the donut reads that directly. Older CLIs that predate the notification (e.g. the Windows recovery build) fall back to the previous hidden `/session-info` probe, so nothing regresses. Automatic compaction, which never refreshed the donut before, now does. ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [src/session.ts](../src/session.ts))
- **Changing reasoning effort no longer restarts the session.** On a CLI that supports per-session effort (grok 0.2.101+ advertises it), the effort change applies live to the running session via `session/set_model` — no more Summarize-or-Restart prompt and no lost context. Older CLIs, and switching effort back to the model default, still restart as before. ([src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts))
- **On Windows, the agent is now told which shell dialect to write for.** The extension runs the agent's commands under PowerShell (or cmd, per your setting), but the agent used to guess the dialect from its own host detection and could emit POSIX-shell idioms that fail. It now sets `GROK_SHELL` in the agent's environment to match the shell we actually run, so the generated commands match the host. ([src/terminal-manager.ts](../src/terminal-manager.ts), [src/sidebar.ts](../src/sidebar.ts))

### Fixed

- **An expired login token no longer forces a sign-out.** A long-lived sidebar session could wedge on an expired OAuth token (the pool shares `~/.grok/auth.json` with the CLI, and a token refresh can lose a rotation race), surfacing as a misleading "you need to pay" error even with an unused SuperGrok limit — while the standalone CLI kept working. The extension now recognizes an auth/entitlement error, transparently restarts that session's process (a fresh one re-reads the current token from disk — what a re-login does, minus the sign-out) and re-sends your message automatically. If the fresh process still can't authenticate, it falls back to the re-login prompt. ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [src/session.ts](../src/session.ts))
- **A failed shell command now shows an error on its row and group, not just inside its output.** A non-zero exit code was only surfaced as `[Error] exit N` in the expandable OUT block; the tool row and its collapsed group looked successful. A failed command now flags the row and group the same way a failed tool does. ([media/chat.js](../media/chat.js))
- **Command labels handle the `(cd dir; cmd)` subshell.** grok wraps commands in a POSIX subshell even on Windows; a row that read "Run (cd" now names the command that actually runs (e.g. "Run node") by stripping the `( )` and skipping the `cd` prelude, and no longer drags a script's path into the label. ([media/webview-helpers.js](../media/webview-helpers.js))
- **A restored BACKGROUND subagent now shows its result + duration on reload**, instead of a stuck card plus a redundant `[subagent:general-purpose] …` poller row. On `session/load` grok flattens the delegation's poller output to a text blob (not the live structured shape); the extension now parses that back, folds it into the card, and drops the poller row. A failed subagent flagged via the tool channel (the common ordering) now renders red too, and a cancelled one reads muted rather than as a failure. ([media/webview-helpers.js](../media/webview-helpers.js), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))

## 1.5.15 — 2026-07-15

### Added

- **Inline edit diffs now show real file line numbers.** The gutter reads each region's actual position from the wire instead of restarting at 1 for every edit — a one-line change at line 147 now reads `147`, not `1`. The line-number column widens automatically past 999. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **A replace-all now shows every replaced site.** Renaming a token across 148 lines renders 148 hunks at their real line numbers and reports **+148 −148**, instead of one meaningless `+1 −1` — the per-site detail was always on the wire, we just weren't reading it. ([media/chat.js](../media/chat.js))

### Changed

- **An edit's `+N −M` appears as each edit lands**, not when the whole tool batch finishes — the counts are on the wire 2–3s before the turn ends. ([media/chat.js](../media/chat.js))

### Fixed

- **A whole-file rewrite of an existing file no longer renders as pure additions.** Grok reports each edit's diff twice, and the optimistic first report claims the file was empty; the authoritative correction was being discarded, so an overwrite showed `+7 −0` instead of the real `+4 −3`. ([media/chat.js](../media/chat.js))
- **Expanding a running tool group no longer snaps shut when the batch finishes.** A manual expand (or collapse) now survives; Expand/Collapse All still overrides it. ([media/chat.js](../media/chat.js))

## 1.5.14 — 2026-07-14

### Fixed

- **Inline-diff line numbers no longer wrap mid-digit.** In an edit's inline diff, line numbers ≥100 could break onto a second row (`147` → `14` / `7`); the gutter is now wide enough and the number never wraps. Thanks to [@jiezaichan](https://github.com/jiezaichan) (#47). ([media/chat.css](../media/chat.css))

## 1.5.13 — 2026-07-13

### Fixed

- **On Windows, the agent's shell commands now run under PowerShell instead of cmd (#46)** — `pwsh.exe` when installed, else Windows PowerShell 5.1 (`powershell.exe`), else cmd.exe. The extension runs every command Grok requests (Grok delegates them over ACP), so the shell was ours to pick; matching the standalone Grok CLI means PowerShell profile functions and pipelines (`… | Format-List`) just work, instead of failing under cmd and forcing the agent into costly retry/re-wrap loops. Linux/macOS are unchanged (`/bin/sh`). ([src/terminal-manager.ts](../src/terminal-manager.ts))
  - **Install PowerShell 7 (`pwsh`) for the best experience** — the Windows PowerShell 5.1 fallback rejects `&&` command chains and reports every failing command's exit code as `1`; pwsh 7 does neither.
  - New **`grok.terminalShell`** setting (`auto` | `cmd`) — an escape hatch back to `cmd.exe` on Windows if the PowerShell host ever causes trouble. ([package.json](../package.json), [src/sidebar.ts](../src/sidebar.ts))
- **Command output now shows in the tool row for the Composer agent too.** Composer runs shell commands in its own CLI-side shell (it doesn't delegate over ACP like Grok Build), so its command rows showed the command (IN) but no output (OUT). The captured output is now read from the completed tool-call update and attached by tool-call id — reliable even though Composer runs commands in parallel and finishes them out of order. ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js))
- **A command row's one-line label no longer drags in a quoted argument.** `Write-Output '=== banner ==='` now reads "Run Write-Output", not a truncated "Run Write-Output === 1. git statu…" — a quoted arg is data, not a subcommand. ([media/webview-helpers.js](../media/webview-helpers.js))

## 1.5.12 — 2026-07-13

### Added

- **Edit diffs are reviewable inline in chat, even under Auto accept (#45).** Every edit row shows an always-visible `+N −M` change count (rolled up onto collapsed "Edited N files" group headers, path-deduped) plus an expandable **inline diff** — a Codex-style line-number gutter, colored left-border stripe, subtle tint, and a `+/−` glyph for color-blind readability. It rides the same expand controls as command IN/OUT, works live and on session restore, and — because the diff data is always on the ACP wire regardless of permission mode — needs no permission card. The native `open diff →` link stays for the full side-by-side. ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js), [media/chat.css](../media/chat.css))

### Changed

- **The gear toggle "Expand command outputs" is now "Expand tool details"** — it governs command IN/OUT blocks **and** edit diffs, matching the *Expand All Tool Details* commands (the `grok.expandCommandOutputs` setting key is unchanged). ` ```diff ` blocks in Grok's messages now share the same Codex diff palette + left-border styling. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [package.json](../package.json))

### Fixed

- **A shell command that exits 0 with no output** now shows a muted `✓ done · no output` marker instead of an empty `(no output)` line. ([media/chat.js](../media/chat.js))

## 1.5.11 — 2026-07-13

### Added

- **Caret lands in the composer after you add context (#43).** Send Selection, Send File, @-mention, the **+** file picker, and image paste all reveal the panel *taking* focus, so you can type your prompt immediately — no click into the input first. ([src/sidebar.ts](../src/sidebar.ts), [src/protocol.ts](../src/protocol.ts), [media/chat.js](../media/chat.js))

### Changed

- **"Grok: Send Selection" is now "Add Selection to Grok",** and a command-sent selection attaches in the **top** attachments row (removable, with its line range) like any other file — only the ambient active-editor chip stays in the bottom toolbar. ([package.json](../package.json), [media/chat.js](../media/chat.js))
- **"Grok: Send File" no longer silently no-ops** from the Command Palette when no file is open — it opens a file picker instead of doing nothing and dropping focus. ([src/sidebar.ts](../src/sidebar.ts), [src/extension.ts](../src/extension.ts))
- The internal debug command (`grok._debugDummyPlan`) is hidden from the Command Palette. ([package.json](../package.json))

## 1.5.10 — 2026-07-12

### Added

- **Expand / collapse all tool details.** Two Command Palette commands — *Grok: Expand All Tool Details (This Session)* / *…Collapse All…* — open or close every tool group and command IN/OUT box, **including a batch that's still running**, and keep applying to tool calls that stream in afterward. It's a per-session latch (last action wins vs the gear setting; flipping the setting clears it) that survives Agent Dashboard focus-swaps and resets on a cold reopen — never persisted to disk. Bind them to a key if you like. ([src/extension.ts](../src/extension.ts), [media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))

### Changed

- **`grok.expandCommandOutputs` now also opens command-bearing tool *groups*,** not just each command's IN/OUT detail — an Auto-accept "Ran N commands" batch is audit-visible with zero extra clicks; explore/edit-only groups stay collapsed. ([media/chat.js](../media/chat.js))
- **Command rows read as "Run \<program\>"** — the executable plus a non-flag subcommand (`Run git status`, `Run npm test`, `Run node`, `Run Get-Date`), not a truncated slab of shell. The full command still lives in the row's IN/OUT detail. ([media/webview-helpers.js](../media/webview-helpers.js))
- Refreshed the README — new mode-picker and image-paste screenshots, and a leaner **Install** section (the extension's onboarding installs the CLI and signs you in) with build-from-source / per-IDE scripts moved to [docs/INSTALL.md](INSTALL.md). ([README.md](README.md))

### Fixed

- **Failed non-shell tools now show their real error inline** instead of a generic "Tool call failed." — the reason is mined from variant-keyed `rawOutput` blobs (e.g. `list_dir` → `NotFound`, `read_file` → `FileReadError`) when there's no `message`/`content` to read. ([media/webview-helpers.js](../media/webview-helpers.js))

## 1.5.9 — 2026-07-12

### Changed

- Documentation-only patch: the README hero screenshot now shows the current UI running **Grok 4.5** ([docs/screenshots/grok_4.5.png](screenshots/grok_4.5.png), replacing the v1.4.20 shot). No code changes.

## 1.5.8 — 2026-07-12

### Fixed

- **RTL text (Arabic, Hebrew, Farsi) now renders correctly** (user report). Every paragraph and block takes its direction from its own first strong character — right-aligned with punctuation on the correct side — across chat bubbles, thinking traces, plan cards, subagent results, tables, lists (markers and indent flip too), and the queued block; the composer follows as you type. Code blocks and inline code stay pinned LTR (the same rule the Codex extension uses), and the chat chrome doesn't move — only text direction changes, per block. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))

## 1.5.7 — 2026-07-12

### Added

- **Command details (#41).** Every shell-command row expands (trailing `›` ↔ `v`) into a Claude-Code-style **IN/OUT block**: the full command text immediately — a lone running command is expandable mid-run — and the complete captured output when it finishes (the extension executes the commands itself, so the output is byte-for-byte what grok received). Exit 0 stays silent; failures render an `[Error] exit N` marker with error-tinted output; kills render a muted `[Cancelled]`. `grok.expandCommandOutputs` (also gear → Config & debug) pre-opens every detail — the audit view for Auto-accept sessions. Live-session only: the CLI doesn't replay terminals on restore. ([src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Changed

- **Tool rows read as one scannable line** — labels trim at 40 chars (full text one click away), long content ellipsizes at the row edge instead of wrapping, and the corner-radius scale is unified (bubbles 12 → code/IN-OUT blocks 8 → inline chips 6). ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- Refreshed the Marketplace description and README (new screenshots: cost control, effort picker, file chips). ([README.md](README.md), [package.json](../package.json))
- Every outbound `session/cancel` is logged with its trigger (Stop click / plan verdict) in the Grok output channel, so any future spurious-cancel report (#37) is attributable at a glance. ([src/acp.ts](../src/acp.ts))

### Fixed

- Private working docs no longer ship inside the public `.vsix` (they were bundled because `.vscodeignore` — not `.gitignore` — decides the package contents). ([.vscodeignore](../.vscodeignore))

## 1.5.6 — 2026-07-11

### Added

- **Subagent rows, fully live.** A delegation renders as a purple *Subagent · \<task\>* row with running dots, then a duration stamp and a click-to-expand result under "Output of the subagent:" — the CLI envelope (plumbing tags, boilerplate lead-ins, one wrapping `<response>` pair, the Agent ID hint) is stripped when present, never failing. Covers grok-build's `spawn_subagent` — including `background: true` spawns, whose started-ack no longer masquerades as the result (the card completes from the output poller's `TaskOutput`, matched by task id) — and the Composer agent's `Task`. The `subagent_spawned`/`subagent_finished` lifecycle events are routed for the day the CLI transmits them (0.2.93 logs them but doesn't send them over ACP — live-verified). Real captured sessions are replayed end-to-end in the test suite. ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js), [src/acp.ts](../src/acp.ts), [test/fixtures/composer-subagent-session.jsonl](../test/fixtures/composer-subagent-session.jsonl))

- **[ACP-feedback.md](internal/ACP-feedback.md)** — an upstream-facing summary of grok-CLI/ACP friction: the grok-build vs Composer wire differences, everything the extension works around or hides (with suggested fixes), what works well, and a Grok 4.5 verification checklist. Built from the wire captures and probes in `research/`.

### Changed

- **One copy/timestamp footer per turn, shown when the turn ends.** The copy action and time sit only under the turn's final agent message (the conclusion) and appear once the turn completes — no more copy icons flickering mid-conversation while grok works; the timestamp reads as the turn's end time. Code blocks keep their own copy buttons. ([media/chat.js](../media/chat.js))
- **The composer grows with your text.** 2 lines at rest (Cursor-style), expanding to 5 as you type, then scrolling; scales with `grok.chatFontScale`. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))

### Fixed

- **No more fake Subagent cards while working on subagent code.** grok titles Grep/Read calls with their query/filename (a search for `spawn_subagent` is titled exactly that), so title matching false-carded ordinary tools; the classifier now treats the wire's `_meta["x.ai/tool"].name` as authoritative both ways and matches exact tool names otherwise. ([media/webview-helpers.js](../media/webview-helpers.js))
- **Subagent child sessions no longer clutter history.** Every delegation persists its child as a top-level session (`session_kind: "subagent"`); the history list hides them, and pagination advances by consumed index slots (`nextOffset`) so hidden rows can't stall or duplicate load-more. ([src/sessions.ts](../src/sessions.ts), [src/sidebar.ts](../src/sidebar.ts))
- **Restored plan/permission cards no longer drift to the end of the conversation.** The host counted replayed `<system-reminder>` turns and marker-only verdicts toward plan positions while the webview (correctly) renders no bubble for them — so every verdict given after a session restore persisted an unreachable position and its card landed at the bottom on the next restore. The host now counts exactly what the webview bubbles (`countsAsUserBubble`). Positions persisted by older builds stay as recorded. ([src/plan-restore.ts](../src/plan-restore.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.5.5 — 2026-07-11

### Changed

- **Codex-inspired chat restyle.** User bubbles use a theme-independent foreground tint (fixes bubbles that vanished on Cursor dark themes), inline and fenced code share one chip surface + editor-contrast text, one 28px ghost icon-button style across header/composer/message/code actions, file refs and "open diff →" render as real links (hover-only underline), plan/permission card text matches the chat font, and the composer types in the UI font instead of the editor's monospace. ([media/chat.css](../media/chat.css), [media/chat.js](../media/chat.js))
- The permanent plan-cancel notice no longer says "Grok is processing the cancellation…" — the transient dots indicator carries that state. ([src/sidebar.ts](../src/sidebar.ts))
- **Resolved plan cards drop the inline plan text.** Once a plan is approved/rejected/cancelled (live or restored), the card shows just the plan-file link + verdict — the file opens as an editor tab; the Show/Hide toggle remains only when no plan file exists. ([media/chat.js](../media/chat.js))
- **Toolbar icons equalized.** The mode button, context donut, and mode-picker icons now use the same 16px glyph and 28px highlight height as the settings/history buttons. ([media/chat.css](../media/chat.css))

### Added

- **Context popover on the donut.** Click the context donut for the exact token count (`used / window`, %). (#39) ([media/chat.js](../media/chat.js))

### Fixed

- **Resolved plan cards stay resolved on re-focus.** Re-opening a live session no longer resurrects an already-answered plan review with active Approve/Reject/Cancel buttons; resolved cards replay collapsed behind Show/Hide plan with their verdict (`planResolved`, the plan twin of `permissionResolved`). ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [src/protocol.ts](../src/protocol.ts))
- **`/session-info` no longer zeroes the context donut.** A turn's `totalTokens: 0` report is never a real measurement (`/compact` shrinks context, it doesn't empty it) and is now always ignored; `/context` (a CLI-TUI no-op over ACP) is hidden from autocomplete — use `/session-info`. (#39) ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/slash-filter.ts](../src/slash-filter.ts))
- **The context donut is real on restore and right after `/compact`.** A restored session seeds the donut from grok's persisted `signals.json` instead of showing 0 until the first turn; and `/compact` is followed by a hidden, CLI-local `/session-info` turn (~25ms, no model call, not persisted to history) whose reply carries the exact post-compact count — parsed and pushed to the donut moments after "Compacted." (the compact turn's own meta reports 0 and the CLI recomputes `signals.json` only at the next turn's end, so this was otherwise unknowable — probe-verified). ([src/sessions.ts](../src/sessions.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [research/signals-refresh-probe.cjs](../research/signals-refresh-probe.cjs))
- **Approving a plan no longer leaks grok's post-verdict filler** ("I'll wait for your verdict…") into the chat: the planning turn the CLI unblocks on our response is cancelled and content-suppressed on Approve exactly as Reject/Cancel already did — that text never survived a session restore, so it doesn't paint live either. ([src/sidebar.ts](../src/sidebar.ts))
- **The welcome logo/byline actually hides once the chat has content** (a CSS `display` rule was overriding the `hidden` attribute), and a primer-only restore keeps the welcome screen instead of showing an empty chat. ([media/chat.css](../media/chat.css), [media/chat.js](../media/chat.js))
- **No more forever-spinning dots after cancelling a plan.** Turn end now always clears the waiting indicator (grok's `[Plan cancelled]` ack can be contentless, which orphaned it), and a plain Cancel is silent by design: the "Plan abandoned" notice is the whole UX — the verdict still reaches grok on a hidden turn, but its ack reply no longer paints. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))
- **White flash on webview load fixed** (VS Code only): an inline critical style paints the theme background immediately and holds the welcome invisible until the stylesheet loads. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.css](../media/chat.css))

## 1.5.4 — 2026-07-11

### Changed

- **One pending message instead of a queue.** Composing more text while a message is already queued now **appends** to the single pending block (blank-line separated — exactly how it sends), rather than stacking separate queue entries. Edit pulls the whole pending text back into the composer, Remove drops it, Stop still hands it back — no more edited messages landing at the end of a queue that was going to collapse into one message anyway. (#37 follow-up) ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))

## 1.5.3 — 2026-07-11

### Fixed

- **Typing while Grok works no longer cancels its tools.** Enter (and the send button) doubled as a hidden Stop while a turn was running, so a mid-turn "continue" silently resolved in-flight tools as *"cancelled by the user"* — amplified by busy-state leaking across dashboard session switches. Typed text now **never cancels**: messages compose into a per-session queue shown as pending blocks at the end of the chat (italic, clock tag, per-message Edit/Remove), survive session switches, and auto-send as one combined message when that session's turn ends — even while backgrounded. Stop (square button, empty composer only) hands queued text back to the composer instead of firing it. Thanks @githubuser1256! (#37) ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts), [src/session.ts](../src/session.ts), [src/protocol.ts](../src/protocol.ts))
- **Enter during CJK IME composition no longer sends mid-composition.** The composer now respects `isComposing`/`keyCode 229`, so Enter confirms the IME candidate (Claude-Code-style: first Enter picks the character, second sends). Thanks @yyu0310! (#38) ([media/chat.js](../media/chat.js))

### Added

- **Live-suite coverage for the Stop contract and concurrent sessions.** `cancel-mid-turn` pins that an id-less `session/cancel` settles the turn as cancelled and leaves the session usable; `parallel-sessions` pins that two CLI processes on one workspace answer overlapping prompts independently. ([scripts/live-tests.cjs](../scripts/live-tests.cjs))

## 1.5.2 — 2026-07-10

### Added

- **One-click "Move view" in the gear menu.** Gear → **Config & debug → Move view** relocates the chat to the Secondary Side Bar, Primary Side Bar, or Panel instantly — direct moves into per-location view containers, no picker — each with a matching panel icon. Especially handy in Cursor, whose side-bar context menu hides the built-in "Move To" entry. ([src/view-move.ts](../src/view-move.ts), [media/chat.js](../media/chat.js))
- **Install scripts detect Cursor and can target every IDE at once.** `cursor` joins the auto-detect chain, and `--all` (Windows: `-All`) builds once and installs into every detected IDE. ([scripts/](../scripts/))

### Changed

- **The view now opens in the Secondary Side Bar by default** (`viewsContainers.secondarySidebar`), next to your other AI tools. This raises the minimum VS Code to **1.106** — older hosts (e.g. Antigravity, currently on base 1.104) keep the last compatible version. A placement you set yourself still wins; use the gear mover or *Reset Location* to adopt the new default.

## 1.5.1 — 2026-07-09

### Fixed

- **The mode button tells the truth when `always-approve` is set in `config.toml`.** grok's global `permission_mode = "always-approve"` (set via Shift+Tab or `/always-approve` in the TUI) auto-approves every session server-side and is invisible over ACP, so the extension used to show a misleading "Agent mode" with no permission cards. It now detects the setting (project `.grok/config.toml` overriding global `~/.grok/config.toml`) and shows **Auto accept**, plus a one-time notice that it's a global config setting. (#31) ([src/grok-config.ts](../src/grok-config.ts), [src/sidebar.ts](../src/sidebar.ts))

### Changed

- **Hidden the `/always-approve` slash command.** It only mutates grok's global `config.toml` — a sticky, surprising side effect — and is a no-op over ACP, so it no longer appears in autocomplete or dispatches. (#31) ([src/slash-filter.ts](../src/slash-filter.ts), [src/acp.ts](../src/acp.ts))
- **Typed the host↔webview message contract.** The host→webview direction was `any`; it's now a discriminated union in `src/protocol.ts` (single source of truth), with the webview keeping a synced mirror and a test asserting both sides agree — so "post one shape, handle another" drift (restore/pagination/media) is a build error. Caught two latent mismatches on the way in. ([src/protocol.ts](../src/protocol.ts), [media/webview-helpers.js](../media/webview-helpers.js))
- **Strengthened the test & release gates.** The `release.*` scripts now run `test:live` by default (`-SkipLive`/`--skip-live` to opt out); the real-grok plan-mode test now models the true approve/reject flows with a disk-snapshot containment canary (the old single-turn test invented an impossible state); the live suite gained a capability-drift probe and a fast `--smoke` lane; and a required `@vscode/test-electron` activation smoke now runs in CI (`npm run test:integration`, validated against a real Extension Host).
- **Documentation consistency pass:** corrected the minimum VS Code version in the README, documented the `Grok: Compact Conversation` command, added the telemetry/mode-prefs/grok-config modules to the architecture map, and trimmed change-history narrative out of `CLAUDE.md` (it points at the changelog and `research/*` instead).

## 1.5.0 — 2026-07-09

### Added

- **Paste or attach images — Grok now sees the pixels.** Ctrl+V a screenshot, drag-drop, or attach a png/jpg/gif/webp and it rides the prompt as an inline vision block (validated at send, 20 MiB cap, session-scoped `[Image #N]` tags that restore as chips; SVG stays a path chip so Grok can edit the source). Thanks @cpulxb! (#32) ([src/chips.ts](../src/chips.ts), [src/prompt-builder.ts](../src/prompt-builder.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **The active-editor context chip tracks your live selection** (`file.ts:8-15`), and selection snippets restore as ranged chips when a session is reopened. Thanks @cpulxb! (#32) ([src/sidebar.ts](../src/sidebar.ts), [media/webview-helpers.js](../media/webview-helpers.js))

### Fixed

- **`/compact` actually compacts again — and says so.** A leading context envelope silently degraded it into an ordinary LLM turn that *grew* context ~6x; confirmed slash commands now lead the text block, the context donut accepts the post-compact reset, the hidden plan-mode primer is re-sent afterwards (thanks @cpulxb! #32), and the turn now ends with a visible **"Compacted."** confirmation. ([src/prompt-builder.ts](../src/prompt-builder.ts), [src/slash-filter.ts](../src/slash-filter.ts), [src/sidebar.ts](../src/sidebar.ts))
- **Plan mode no longer blocks safe chained commands.** `cd repo && git status` was rejected outright, which crashed grok-4.5's planning phase; chains (`&&`, `||`, `;`) now pass when **every** segment is read-only — one mutating segment still blocks the whole command. (#36) ([src/plan-gate.ts](../src/plan-gate.ts))

### Changed

- **Composer polish:** one focusable card, VS Code-style webview scrollbars, and the caret lands in the input on panel open, window refocus, new session, and session switches (thanks @cpulxb! #32); pasted images that can't be read block the send instead of silently dropping, and inline images carry a do-not-read-from-disk hint so Grok stops noisily `Read`-attempting its own copy. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))

## 1.4.31 — 2026-07-09

### Added

- **The install/uninstall scripts can target any code-compatible IDE.** Pass a CLI name or path — `./scripts/install.sh antigravity-ide` (Windows: `pwsh scripts\install.ps1 -Cli antigravity`) — or set `CODE_CLI=…`; with no argument they auto-detect `code` → `code-insiders` → Antigravity and hint at other IDEs they found. Thanks @mingminghome for the Antigravity groundwork. (#35) ([scripts/](../scripts/))

### Fixed

- **Session startup no longer crashes on an invalid or unavailable `grok.defaultModel`.** A failed `setModel` on session create/load is caught and logged, falling back to the CLI's current model instead of exiting; if the configured model isn't in the CLI's list, a warning toast suggests updating the setting. Thanks @mingminghome. (#33, #34) ([src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.4.30 — 2026-07-09

### Fixed

- **The sign-in (and sign-out) terminal commands actually run now.** The onboarding button typed `"C:\…\grok.exe" /login` into the terminal — the wrong command (`login` is the CLI subcommand; `/login` only works inside the interactive TUI) *and* a PowerShell parser error (a quoted path followed by arguments needs the `&` call operator). Sign-in and sign-out now launch the grok binary directly as the terminal's own process, which behaves the same on PowerShell, cmd, and POSIX shells. README examples updated to `grok login` too. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts), [README.md](README.md))

### Changed

- The API-key option in the sign-in onboarding no longer claims extra models — it now just says "pay per token". ([media/chat.js](../media/chat.js))

## 1.4.29 — 2026-07-05

### Fixed

- **A permission request that's only an edit is now reviewable, and its diff survives a VS Code restart.** A standalone edit collapsed to a bare one-line row with no way to open the diff — while a read+edit batch stayed expandable — and on restore the diff was lost entirely. A lone edit now keeps the same collapsible tool group (chevron, "N → M lines", "open diff →") as a multi-tool batch, in both the live and resumed orderings. ([media/chat.js](../media/chat.js)) (#30)

## 1.4.28 — 2026-07-01

### Fixed

- **The mode switch (Agent / Plan / Auto-accept) is now disabled while the session is starting.** Picking a mode before the session existed called `setMode` too early and surfaced *"Couldn't switch mode: no session."* The mode button is greyed out and unclickable until the session is ready — like the send button — and the toggle-mode command is guarded server-side too. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))

## 1.4.27 — 2026-07-01

### Added

- **Context files now tell Grok how they got there.** A file you explicitly attach is listed as **"Attached file(s)"** (strong intent); the file that's auto-included because it's open in your editor is listed separately as **"Currently open in the editor (for context)"** (weaker, ambient) — so Grok doesn't treat a file you're just looking at as one you asked it to act on. ([src/prompt-builder.ts](../src/prompt-builder.ts))
- **Uploaded attachments now have their own row above the input**, each with a remove (×) button. The active-editor file stays in the bottom toolbar as before. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))

### Fixed

- **grok-build now shows its real name and 512K context window.** grok resolves a `set_model("grok-build")` to a *versioned* id (`grok-build-0.1`) that isn't in the model list, so the toolbar showed the raw id and the context donut fell back to the 200K default (percentage read ~2.5× too high). The id is now normalized back to the list entry, and the window recomputes on every model change. ([src/acp.ts](../src/acp.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts), [media/chat.js](../media/chat.js))
- **The voice/mic button no longer jumps when attachments appear.** It's now anchored to the input box instead of the composer, so the new attachments row above the input doesn't shove it out of place. ([media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))
- **Attachment chips show just the filename** — in the composer, the sent-message bubble, *and* restored sessions — for files outside the workspace (Windows absolute paths were previously shown in full); the full path stays on the hover tooltip, and Grok still receives the full path. The file-path context is sent in a machine-readable `<vscode-context>` envelope so the webview can parse it back deterministically on restore instead of showing the raw replayed paths. ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js), [src/prompt-builder.ts](../src/prompt-builder.ts))
- **Code blocks no longer render with a doubled blank line around them.** A fenced code block was wrapped in `<br><br>` on top of its own margin (the model sends just one blank line), so it looked double-spaced; code blocks are now emitted as their own block, like tables and math. ([media/chat.js](../media/chat.js))

## 1.4.26 — 2026-06-30

### Fixed

- **Updating the Grok Build CLI no longer fails with "cannot rename locked executable."** The update tore the session pool down but didn't *wait* for the grok processes to actually exit, so `grok update` raced the still-held Windows lock on `grok.exe` (`Access is denied. (os error 5)`). Teardown now resolves only once each process has truly exited, kills the whole process **tree** on Windows (`taskkill /T /F`, so grok's backgrounded subagent/command children don't keep the binary locked), and the update retries once if a lingering lock slips through. ([src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts), [src/cli-locator.ts](../src/cli-locator.ts))

### Changed

- **Directory listings show the full relative path with a trailing slash** — `List docs/` and `List docs/screenshots/` instead of the basename-only `List screenshots`. ([media/chat.js](../media/chat.js))

## 1.4.25 — 2026-06-30

### Fixed

- **Empty primer-only sessions are cleaned up even when large.** A hidden-primer turn can balloon to dozens of agentic tool/reasoning messages with no real user message; the startup sweep skipped those (`num_messages` over the gate) so they lingered in history with a primer-derived title. The chat-history content check is now authoritative regardless of message count — a session with our primer and zero real user queries is swept (real and renamed sessions are still never touched). ([src/sessions.ts](../src/sessions.ts), [src/sidebar.ts](../src/sidebar.ts))
- **The send button now shows the spinner from the moment the panel opens.** During the initial session spin-up it briefly showed neither the send arrow nor the spinner; it now defaults to the disabled spinner until the session is live. ([media/chat.js](../media/chat.js))
- **Tool rows now show the detail again for List / Search / Fetch.** A directory listing shows the folder (`List docs`), a read shows the file and line range (`Read README.md lines 1-30`), a search shows the pattern, and a web fetch shows the page URL — these had regressed to a bare verb because the rawInput field names (`target_directory`, `url`) weren't being read. Verified against real on-disk sessions. ([media/chat.js](../media/chat.js))

### Changed

- **The diff-preview edit row is now a single line** — `Edit chat.js  9 → 10 lines  open diff →` instead of three stacked lines. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Table cells no longer break mid-word.** Long header/cell words were chopped between letters, making columns look cramped and arbitrarily narrow; cells now wrap only at spaces and hyphens (an unbreakable run falls back to the table's horizontal scroll). ([media/chat.css](../media/chat.css))
- **The Grokking indicator spins the other way.** ([media/chat.css](../media/chat.css))
- **The scroll-to-bottom button sits slightly higher**, so its gap above the composer's top border matches the border-to-textarea gap. ([media/chat.css](../media/chat.css))
- **Trimmed the README privacy section** to a short privacy-by-design summary; the full detail moved to [docs/privacy.md](privacy.md). ([README.md](README.md), [docs/privacy.md](privacy.md))

## 1.4.24 — 2026-06-29

> Privacy-first, opt-out anonymous usage telemetry.

### Added

- **Anonymous usage telemetry (Aptabase).** One `session_start` event per session — fired on the **first real user message** (never the primer or empty/abandoned sessions) — carrying only an anonymous install id (a random GUID, no account or grok-login identity) plus the chosen **mode / model / effort**. **No message content, code, or file paths are ever sent;** country is derived by Aptabase from the request IP and the IP is then discarded. **On by default but fully gated** — it sends only when VS Code's global `telemetry.telemetryLevel` is enabled *and* the new `grok.telemetry.enabled` setting is on; either off stops everything. The event is built synchronously (capturing the right session's mode/model/effort) but **fired asynchronously off the send path** and any error is **swallowed silently**, so telemetry can never slow, surface to, or break a turn — a failure (offline, a wrong/typo'd key → a harmless 404, a malformed event) just means nothing lands. Thin, dependency-free client (no SDK). ([src/telemetry.ts](../src/telemetry.ts), [src/sidebar.ts](../src/sidebar.ts), [package.json](../package.json))

### Tests — 609

- New: the telemetry helpers — `aptabaseHost` (region from app key), `osNameFromPlatform`, the `shouldSendTelemetry` two-gate check, distinct prod/dev keys, `buildSessionStartEvent` (install id + mode/model/effort as props, no content), and that `postEvent` **never throws** (a circular/malformed event or a no-region key is a silent no-op) ([test/telemetry.test.ts](../test/telemetry.test.ts)). The unit suite stays network-free; a separate `npm run telemetry:probe` ([scripts/telemetry-probe.cjs](../scripts/telemetry-probe.cjs), with an `APTABASE_KEY` override to fire a wrong key) sends real events to a **dev** Aptabase project (the published extension always reports to prod).

## 1.4.23 — 2026-06-29

> Hidden-by-default thinking traces with an always-on progress indicator, a scroll-to-bottom button, a remembered mode preference, and the YOLO → Auto accept rename.

### Added

- **Thinking traces are hidden by default (#26).** Grok's reasoning no longer fills the chat — a muted **Thinking…** stand-in (brain icon) shows while it reasons. Turn traces back on from gear → **Config & debug → Show thinking traces** (a live switch backed by `grok.showThinking`); it reveals them on already-loaded sessions too. When shown, a thinking row now matches the tool rows — same font size, a leading **brain icon**, and the shared chevron + hover (it was a smaller 11px and icon-less). ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts), [package.json](../package.json))
- **The chat always shows live progress during a turn.** While a turn is in flight, one of **Grokking / a running tool / Thinking…** is guaranteed on screen — no dead frames, even with traces hidden. ([media/chat.js](../media/chat.js))
- **Scroll to bottom (#28).** A floating button appears above the composer once you scroll up off the bottom; click it for an animated jump back down. It's anchored to the chat input area, so it stays correctly placed at any `chatFontScale` zoom. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **New sessions remember your last mode (#25).** The last switch between **Agent** and **Auto accept** is reapplied on new sessions (Plan is deliberately never remembered), mirroring how model & effort already persist. It's applied up-front, so the toolbar shows the right mode from the first paint — no Agent → Auto accept flash while the session primes. Backed by `grok.defaultMode`. ([src/sidebar.ts](../src/sidebar.ts), [package.json](../package.json))

### Changed

- **The progress indicators now share one look.** *Grokking*, the *Thinking…* stand-in, and a running tool all use the editor font size, a 15px leading icon, and the same muted color + spacing — a running tool no longer brightens to look hovered. Motion is per-indicator: *Grokking* spins a lucide **orbit** icon (it's a generic wait), while *Thinking* and tools use the **three blinking dots** (discrete progress) — both replacing the old morphing "…" pills. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Renamed the "YOLO" mode to "Auto accept."** The mode picker and the bottom-toolbar button now read **Auto accept**; "YOLO" survives only in the picker's one-line description. The internal mode id (`yolo`) and `autoApprove` flag are unchanged. ([media/chat.js](../media/chat.js))
- **A user message's copy + timestamp now appear on hover** (the bubble or the row beneath it), matching grok messages — they used to always show. ([media/chat.css](../media/chat.css))
- **Trimmed the README feature descriptions** that already carry a screenshot, cutting the redundant "what it looks like" prose. ([README.md](README.md))

### Tests — 599

- New: the Auto accept label, the thinking-traces toggle (hidden-by-default body class, live flip, the **Thinking…** stand-in vs. a visible trace, the Config & debug switch), the Grokking orbit indicator, the scroll-to-bottom visibility threshold + click, and a **step-by-step turn simulation** asserting a live progress indicator after every mid-turn event with traces hidden *and* shown ([test/webview-ui.dom.test.ts](../test/webview-ui.dom.test.ts), [test/webview-harness.ts](../test/webview-harness.ts)); the remembered-mode policy `modeToRemember`/`startsInYolo` — Plan never persisted, applied to new sessions only (#25) ([test/mode-prefs.test.ts](../test/mode-prefs.test.ts)).

## 1.4.22 — 2026-06-29

> Single-home the sidebar so it can be moved in Cursor, and stop forcing whole-file reads on attachments.

### Fixed

- **The view can be relocated again (Cursor).** We declared the `grokSidebar` container in **two** places at once (`activitybar` + `secondarySideBar`); `secondarySideBar` only exists in VS Code ≥ 1.106, so on older bases (incl. current Cursor) the stray declaration is parsed-but-unsupported — it pinned the view to the left and could even shift *other* extensions' views. The container is now single-homed to `activitybar`; relocate it with right-click the **Grok** title → **Move To → Secondary Side Bar** (it persists). ([package.json](../package.json))
- **Attached files are handed to grok as paths, not `@`-reads.** A file chip used to become `@relPath`, grok's "read this whole file" convention — which slurped large files (a big CSV/log) into context and *failed outright on binaries*: an attached image or video triggered `read_file` → *"Cannot read binary file"* (grok has no vision). Chips now render as a plain **"Attached file(s):"** path list, so grok decides how to consume each — grep/range-read big text, pass image/video paths to its media tools, read small files in full. Selected-range chips still inline the exact lines you picked. ([src/prompt-builder.ts](../src/prompt-builder.ts))
- **Corrected the subscription requirement.** The sign-in screen claimed *SuperGrok **Heavy*** was required for Grok Build — wrong on two counts: it's **any SuperGrok *or* X Premium+** subscription, and naming the $300/mo Heavy tier scared off eligible users. Fixed in the onboarding, README, and Marketplace description (and clarified that Grok's free tier doesn't include the CLI agent). ([media/chat.js](../media/chat.js), [README.md](README.md), [package.json](../package.json))

### Changed

- **Renamed the "Voice input" feature to "Voice control"** across the UI and docs. ([README.md](README.md), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **Welcome byline reads "(The Product Compass)"** again (dropped the "Newsletter" suffix). ([src/sidebar.ts](../src/sidebar.ts))

## 1.4.21 — 2026-06-29

> Documentation-only patch: the README screenshots now match the current (v1.4.20) UI.

### Changed

- **README screenshots refreshed.** New hero image, plus shots for **session history**, the redesigned **tool-call rows**, and the **permission diff-preview** card; the tool-calls description now matches the categorized/icon design. The old v1.2.0 sidebar screenshot is removed. ([README.md](README.md), [docs/screenshots/](screenshots/))

## 1.4.20 — 2026-06-28

> A chat-readability overhaul plus housekeeping: tool and thinking rows get Codex-style category icons and a muted-until-hover look, failed tools finally show *why*, each narration sits above the tools it describes, and the empty "primer" sessions stop cluttering history (#24). Also renamed **Unofficial → Community**.

### Changed

- **Tool-call summaries are categorized by what the tool actually did.** Reads, globs, and greps were all rolled up as "Ran N commands"; they're now bucketed by ACP kind into "Explored N items" / "Edited N files" / "Deleted N files" / "searched web" / "Ran N commands" — so a turn that read five files reads "Explored 5 items", not "Ran 5 commands". Works on resumed sessions too: when the wire form omits `kind`, the category is recovered from the tool's title. ([media/chat.js](../media/chat.js))
- **A turn's narration now interleaves with its tool groups instead of piling above them.** grok narrates each step then runs its tools (narrate → tools → narrate → tools); the narration used to coalesce into one bubble with the tool summaries stacked consecutively below it, so the summaries looked arbitrary. Each narration sentence now renders directly above the tool group it introduced, preserving grok's actual order. ([media/chat.js](../media/chat.js))
- **Tool and thinking rows restyled (Codex-aligned).** Each tool row (single or group) now leads with one **lucide category icon** — `file` (read) / `folder-search` (search) / `pencil` (edit) / `square-terminal` (command, and the catch-all), picked by the strongest action in a group. Rows are flush-left in the standard font, **muted by default and brighten on hover** (no background highlight); a running group stays "active" until it completes. Expanded bodies use a thin secondary border (not blue). Thinking blocks now share the tool rows' chevron — same glyph, on the **right**, after the label — and the same expand border. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Generated images/videos align with the message text** — dropped the extra horizontal inset they carried. ([media/chat.css](../media/chat.css))
- **Renamed "Unofficial" → "Community".** The chat header, extension title, and README now read **Grok Build (Community)** / **Grok Build for VS Code (Community)**; the About fine print still notes it's unofficial, community-built, and not affiliated with xAI. ([package.json](../package.json), [README.md](README.md), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Fixed

- **Tool-call labels no longer leak raw regex/glob patterns.** A search tool used to render its bare pattern (e.g. `image_edit|/imagine`) as the whole label; it now shows `Search <pattern>`, and any tool we didn't predict falls back to grok's own formatted title instead of scraping arbitrary raw input. ([media/chat.js](../media/chat.js))
- **Failed tool calls now show their reason instead of being silently dropped.** A `status: "failed"` tool update (e.g. *"Tool `image_to_video` failed: image reference not readable: …"* — grok occasionally malforms an image argument) used to render as nothing, so grok just looked like it gave up. The row now goes error-colored with the failure message beneath it (and a collapsed group with a failed child tints its icon red). ([media/webview-helpers.js](../media/webview-helpers.js), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Empty "primer" sessions stop piling up in history (#24).** Each time the extension opened it left behind an empty, primer-only session (the ones titled "… Primer v4 Plan Mode …"). Now abandoning an empty session — New Session, or switching to another — deletes it on the spot, so at most one untitled **New session** ever exists; and a one-shot startup sweep clears the empties earlier runs left behind, each confirmed primer-only by **reading its chat history** so a real or non-extension session is never touched. Detection is content-based and agent-agnostic — it counts both `<user_query>`-wrapped prompts and the **unwrapped** ones grok/composer sends for slash commands like `/imagine` (so a real composer session is never mistaken for empty) — verified against real on-disk sessions from both the `grok-build` and `cursor` (composer) agents. The live untitled session always shows as **New session**, never grok's primer-derived title. ([src/sidebar.ts](../src/sidebar.ts), [src/sessions.ts](../src/sessions.ts), [src/grok-primer.ts](../src/grok-primer.ts))

### Tests — 582

- New: tool-call categorization rebuilt from real Grok + Composer transcripts, the raw-pattern-leak fix, the unpredicted-tool fallback, narration↔tool-group interleaving, plan/permission cards landing below the interleaved lead-up, the per-row **category icons** (strongest-action pick), and **failed-tool surfacing**, driving the real `media/chat.js` ([test/tool-summary.dom.test.ts](../test/tool-summary.dom.test.ts)); the thinking↔tool **chevron unification** ([test/webview-ui.dom.test.ts](../test/webview-ui.dom.test.ts)); empty-primer-session detection incl. unwrapped composer prompts — `extractUserQueries` / `classifyUserQueries` / `isEmptyPrimerSession` ([test/sessions.test.ts](../test/sessions.test.ts)) and `isPrimerSummary` ([test/grok-primer.test.ts](../test/grok-primer.test.ts)).

## 1.4.19 — 2026-06-28

> Card-UX polish from a live image-generation session: permission cards read in order and minimize once answered, restored plans start collapsed, and background-task notices stop polluting the chat.

### Fixed

- **Grok's reply after a permission prompt now renders *below* the card, not above it.** A permission request arrives mid-turn, so streaming kept appending to the agent bubble already on screen *above* the new card — only a fresh user turn pushed the conversation past it. The card now finalizes the in-flight turn first (the `commitAgentTurn()` the plan card already used), so everything after the answer lands beneath it, in order. ([media/chat.js](../media/chat.js))
- **Answered permission cards no longer reappear *active* when you re-focus a backgrounded session.** Re-focusing replays the session's post buffer, but the answer (a webview-only collapse) was never in it, so an already-decided card came back fully expanded with live buttons. The host now records a `permissionResolved` marker in the buffer on answer, so the replayed card comes back collapsed. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Added

- **Answered permission cards now persist across a full reload.** The CLI doesn't replay `session/request_permission` on `session/load`, so resumed sessions used to lose every approval you'd made. The extension now persists each answered card (title + allowed/rejected + the gated tool-call id) and replays it as a **collapsed** card **anchored to the exact tool it gated** — by tool-call id, or by the tool's title when no id was captured (the card title *is* the tool's title) — so it lands where you answered it, mid-turn, not at the turn boundary (with a user-message-position fallback if the tool never replays). ([src/sidebar.ts](../src/sidebar.ts), [src/session.ts](../src/session.ts), [src/sessions.ts](../src/sessions.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts), [media/chat.js](../media/chat.js))

### Changed

- **Answered permission cards collapse to one muted line.** Picking an option used to leave the full card with greyed-out buttons and a "you chose: …" note in the transcript. It now minimizes to a single non-interactive line — a colored `Allowed` / `Rejected` verb plus what it applied to — matching the resolved question/plan cards, with the "Grokking…" indicator underneath until grok resumes. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Restored plan cards start collapsed.** Resuming a long session no longer dumps full plan text — each restored plan shows its title, verdict, and a `Show plan` / `Hide plan` toggle (the body stays in the DOM, just hidden). ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Background-task completion is a one-shot toast, not a chat bubble.** When grok backgrounds a long command (e.g. a nested `grok -p …` image/video job), the CLI emits a structured `task_completed` update *and* feeds the result back as a `user_message_chunk` wrapped in `<system-reminder>…`. The extension now routes `task_backgrounded` / `task_completed` to their own events, pops a single `showInformationMessage` (with **Show Logs**) on completion — skipped during session replay — and drops the replayed `<system-reminder>` turn so it never surfaces as a fake user bubble on restore. ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Tests — 545

- New: `task_backgrounded` / `task_completed` routing, `summarizeBackgroundCommand`, and `permissionOutcomeFor` ([test/acp-dispatch.test.ts](../test/acp-dispatch.test.ts)); permission-card ordering + collapse + re-focus survival + restored-collapsed-card interleaving, restored-plan collapse toggle, and `<system-reminder>` suppression on restore, driving the real `media/chat.js` ([test/card-collapse-tasks.dom.test.ts](../test/card-collapse-tasks.dom.test.ts)).

## 1.4.18 — 2026-06-28

> Grok CLI fixed the #22 Windows session-start regression (0.2.71, now on stable as 0.2.72) — adopt it and re-enable updates.

### Fixed

- **Sessions start on the latest Grok CLI again, and Windows updates are no longer paused (#22).** xAI fixed the `agent stdio` regression that hung session start on Windows across 0.2.61–0.2.70 (initialize on 0.2.61–0.2.64, then `session/new` on 0.2.67–0.2.70). The fix landed in **0.2.71** and is now on the **stable** channel as **0.2.72**. Verified end-to-end on native Windows — the `session/new` stdin-open probe passes and the full live ACP gate is green (handshake, prompt round-trip, session restore, plan-mode, subagent). The extension now treats **0.2.72 as the supported build**: it pins the bounded broken range **0.2.61–0.2.70** up to 0.2.72 before starting, and the gear → **Update Grok Build CLI** action (and the silent on-upgrade update) work normally again on Windows. The reactive downgrade-on-failure remains a backstop for any *future* still-broken build above 0.2.72. ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.4.17 — 2026-06-27

> Pin Windows to the last working Grok CLI for *any* newer build — 0.2.61–0.2.69 all break session start (#22).

### Changed

- **The #22 Windows guard now pins *any* Grok CLI build above 0.2.60 back to 0.2.60 before starting**, instead of tracking a fixed broken range. 0.2.61–0.2.64 hang at `initialize`; 0.2.67 (stable) and 0.2.69 (alpha) answer `initialize` but hang at `session/new` — the bug has persisted on every build above 0.2.60, with no fix on either channel. Rather than widen a range per build (and eat a ~120s reactive hang on each new one), the extension treats everything newer than the supported 0.2.60 as broken on Windows. When xAI ships a build that passes the `session/new` check, raising the supported version one line adopts it; the reactive downgrade-on-failure stays as a backstop. ([src/cli-locator.ts](../src/cli-locator.ts))

## 1.4.16 — 2026-06-26

> Clearer listing and docs; lighter changelog.

### Changed

- **README rewritten** to lead with what the extension does for you — diff-preview approvals, `@file` context, inline image/video, voice — instead of internals, with a trimmed feature list.
- **Listing clarified** as an **unofficial community extension** (display name + description).
- **Changelog slimmed:** releases before 1.4.0 moved to [docs/CHANGELOG-ARCHIVE.md](CHANGELOG-ARCHIVE.md); entries stay terse going forward.

## 1.4.15 — 2026-06-26

> Cover the #22 Windows session-start bug on newer Grok CLI builds (through 0.2.67) and when the hang moves to session start.

### Fixes

- **The Windows session-start workaround now covers Grok CLI 0.2.65–0.2.67 and a `session/new`-stage hang (#22).** Grok CLI 0.2.67 *looked* fixed — the ACP `initialize` handshake answers again — but the stdin-until-EOF regression only **moved**: the next request, `session/new`, now hangs instead (with stdin held open, as any live client must), so a real session still can't start. v1.4.14 only knew the 0.2.61–0.2.64 range and only recognized an `initialize`-stage hang, so anyone landing on 0.2.65–0.2.67 was left stuck. Now: the proactive pin covers the full confirmed-broken range **0.2.61–0.2.67** and pins the CLI back to the last fully-working **0.2.60** before starting; and the evidence-driven reactive recovery also fires on a **`session/new` / `session/load`** timeout, not just `initialize` — so a future still-broken build self-heals on the observed failure regardless of which startup request hangs. Verified with a controlled stdin-open probe (`initialize` then `session/new`) against real 0.2.67. ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts))

### Docs

- Recorded that **0.2.67 does not fix #22** — the hang moved from `initialize` to `session/new` — with the reproduction probe in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md). Rewrote CLAUDE.md's status into a concise current-state project map (per-version history lives here in the changelog, not there).

## 1.4.14 — 2026-06-25

> Smoother diff review on permission cards.

### Features

- **Diff previews don't nag you to save, auto-open, and clean up after themselves (#21).** Closing a diff preview **no longer prompts you to save**: every diff the extension opens — whether from the *open diff preview →* link on an edit card or auto-opened on a permission card — is now backed by read-only virtual documents instead of scratch buffers, so there's nothing to save (and you also get proper syntax highlighting now). On a permission card the diff also **opens automatically** (the *open diff →* button stays, to re-open it) and **closes itself** when you click **Allow / Reject**. The preview reuses a single tab across Grok's many small sequential edits and keeps focus on the chat, so reviewing a stream of edits is just: glance, decide, repeat. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

## 1.4.13 — 2026-06-25

> Self-healing recovery if a *future* Grok CLI build ships the same Windows bug. _(Not released on its own — rolled into the 1.4.14 release.)_

### Fixes

- **Auto-recovers from a still-broken future CLI build, not just the known ones (#22).** v1.4.12 pins the CLI back to 0.2.60 when it detects one of the *known* broken builds (0.2.61–0.2.64) before starting. But if xAI ships a **new** build (0.2.65+) that still has the bug, that closed range wouldn't catch it and the session would hang with no automatic fix. The extension now also recovers **reactively**: if a session fails to start on Windows with the regression's signature (the `initialize` handshake timing out / *"exited (code null)"*) and the CLI is on any build newer than the supported 0.2.60, it automatically downgrades to 0.2.60 and **retries the start once** — triggered by the actual failure rather than a hardcoded version list, so it self-heals on builds that don't exist yet. If you later update the CLI by hand onto another broken build, the same recovery runs again on the next failure. Every automatic downgrade (proactive or reactive) shows a notification explaining what happened. If the downgrade can't run, you still get the manual-workaround message as before. ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts))

### Internal

- Verified on macOS (Apple Silicon) that the regression is **Windows-only** — grok 0.2.64, the build that hangs on Windows, completes the stdin-open ACP `initialize` handshake in ~450ms (4/4 runs) — so the whole workaround stays correctly gated to Windows. Recorded in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md) with a reproduction probe. ([research/stdio-eof-mac-probe.cjs](../research/stdio-eof-mac-probe.cjs))

## 1.4.12 — 2026-06-25

> Works around a Grok CLI 0.2.61+ bug that stopped sessions from starting.

### Fixes

- **Sessions start again on Grok CLI 0.2.61–0.2.64 (#22).** A regression in the Grok CLI broke `grok agent stdio`: the agent no longer reads its first line of input until the input stream is closed, which never happens for a live connection — so the extension's startup handshake hung forever and you saw *"Grok exited (code null)"* / *"ACP request timed out: initialize"*. The last working build is **0.2.60**. Since the extension can't make the CLI read its input, it now **detects a broken CLI version on startup and automatically pins it back to 0.2.60** before connecting, with a one-time notice — no manual downgrade needed. Once the CLI is healthy again nothing is changed. If the automatic downgrade can't run, the start-failure message now tells you exactly how to fix it by hand (`grok update --version 0.2.60`). The version range is bounded to the known-broken builds so a future fixed release won't be needlessly downgraded. (The regression has so far only been reported on Windows, so the automatic pin and the update guard below currently apply there.) ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts))
- **"Update Grok Build CLI" won't move you onto a broken build.** Because Grok CLI 0.2.61+ is unusable by the extension (above), the gear → **About** update action is now **disabled with a note** when you're on the latest supported version (0.2.60) or newer — so a one-click update can't reinstall a broken build. It stays enabled only when you're on something *older* than 0.2.60, and in that case it updates **to 0.2.60** (never to an unsupported `latest`). The silent on-upgrade CLI update follows the same rule. ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Docs

- Documented the root cause, the controlled reproduction, and a copy-paste bug report for xAI in [research/stdio-eof-regression.md](../research/stdio-eof-regression.md).

## 1.4.11 — 2026-06-20

> Nested code blocks render correctly.

### Fixes

- **Nested code blocks no longer eat the outer fence (#20).** Asking the chat for a code block fenced by 4 or 5 backticks (so it can contain an inner ```` ``` ```` block) used to strip the first three backticks of the outer fence and close the block early at the inner fence — splitting one block into several and mangling the output. The Markdown renderer now matches a fence of three-or-more backticks and requires the closing fence to be the same length, so a longer outer fence correctly wraps shorter inner ones (per the CommonMark spec). This makes clean, copy-pasteable nested examples (e.g. for an `AGENTS.md`) render the same as on grok.com and in the Grok CLI. ([media/chat.js](../media/chat.js))

## 1.4.10 — 2026-06-18

> Session history that stays fast with thousands of sessions.

### Features

- **Session history loads in pages and stays fast at scale.** The history dropdown used to read and parse *every* saved session on each open, which got slow once a project had hundreds or thousands of them. It now loads the **most recent 100** (newest first by last activity) and pulls in older ones as you **scroll to the bottom**. The **search box** filters by name across your **entire** history — not just the loaded page — so you can still find an old session instantly. Behind the scenes it orders sessions with one cheap directory `stat` each (no file reads), reads only the page you're looking at, and caches by file modification time so re-opening the dropdown costs effectively no disk reads. ([src/sessions.ts](../src/sessions.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Switching model or reasoning effort on a fresh session no longer clutters history.** Some model and effort changes need the session to restart. If you flip them a few times right after opening a session — before you've actually said anything — each restart used to leave behind an empty, identical session in your history. Now an empty session (one where only the hidden setup has run) restarts cleanly with no "Summarize & Restart vs. Just Restart" prompt, and the throwaway session is removed instead of piling up. If you had renamed that session, the name carries over to the restarted one. ([src/sidebar.ts](../src/sidebar.ts), [src/sessions.ts](../src/sessions.ts))

### Fixes

- **History dropdown no longer opens clipped off the right edge.** Opening the session-history popover quickly (before its rows had finished loading) could position it too far right, so it spilled past the panel edge and only looked right after closing and reopening. The popover is now right-aligned to the panel (respecting the edge padding) and grows leftward, so it stays fully on-screen no matter how its contents resize as sessions load in. In a narrow panel it also caps its width to fit, so a long session name truncates with an ellipsis instead of pushing the popover off the left edge. Resizing the panel while the dropdown is open now re-fits it live (no need to close and reopen), and switching to another panel tab or extension closes it so it can't reappear mis-sized when you come back. ([media/chat.js](../media/chat.js))

### Internal

- **Opt-in performance simulation for the history popover.** A new `npm run test:perf` suite (kept out of `npm test` and CI) builds a 5000-session in-memory store and asserts the access-count improvement: first open drops file reads from 5000 to 100 (~98%), a repeat open does zero reads (modification-time cache), and search warms the catalog once then stays read-free — with a modeled-latency projection and a real in-memory parse-cost wall-clock. ([test/sessions.perf.ts](../test/sessions.perf.ts), [vitest.perf.config.ts](../vitest.perf.config.ts), [package.json](../package.json))

### Docs

- Documented the pagination design in [docs/architecture.md](architecture.md) (§ History at scale) and [CLAUDE.md](../CLAUDE.md) (§ History pagination), and updated the *Session history* feature note in the [README](README.md).

## 1.4.9 — 2026-06-16

> Make the chat bigger — just the chat.

### Features

- **Adjustable chat font size (#14).** A new `grok.chatFontScale` setting zooms the Grok chat panel only — text, icons, and spacing together — as a percent (e.g. `150`, `200`, or smaller like `70`). Unlike VS Code's global `Ctrl/Cmd+Shift+=`, it leaves the rest of the editor at its normal size, so you can enlarge (or shrink) just the chat for readability. It applies live with no reload, the composer stays pinned to the bottom of the panel at any scale, and it works at both User (global) and Workspace (local) scope. ([package.json](../package.json), [src/sidebar.ts](../src/sidebar.ts), [media/chat.css](../media/chat.css), [media/chat.js](../media/chat.js))

### Docs

- **README polish.** Added screenshots for *Voice input* and the *Agent Dashboard*, and moved a few wire-level implementation details out of the feature blurbs into [docs/architecture.md](architecture.md) so the feature list reads less like internals. ([README.md](README.md), [docs/architecture.md](architecture.md))

## 1.4.8 — 2026-06-15

> Run several Grok sessions at once — switch between them instantly, and see at a glance which one needs you.

### Features

- **Multi-session Agent Dashboard.** The sidebar now keeps several sessions *alive* at once instead of one at a time. Switching between them from the history dropdown is **instant and lossless** — the conversation you switch away from keeps running in the background (mid-turn, mid-approval, anything), and switching back replays its exact state with no reload. Picking a session that isn't live anymore loads it from history as before. ([src/sidebar.ts](../src/sidebar.ts), [src/session.ts](../src/session.ts))
- **Status dots in the history dropdown.** Every session shows a dot so you can see what each one is doing without opening it. It's **gray** at rest, and only lights up when there's something to know: **blue** = working, **yellow** = needs you (a permission, question, or plan to review), **green** = finished with output you haven't opened yet, **red** = finished with an error you haven't opened. The green/red marker is an *unread* badge — it clears the moment you open the session, and it's **persisted**, so it survives the idle cleanup below and even a VS Code restart. Walk away, come back, and the green sessions are exactly the ones with results waiting. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/session-pool.ts](../src/session-pool.ts))
- **Idle sessions are cleaned up automatically.** To keep a pile of background sessions from each holding a live process, a session left untouched for an hour — or beyond a cap of ~8 live — is quietly shut down (never one that's working or waiting on you). It reappears in history and reloads on click, so nothing is lost. ([src/session-pool.ts](../src/session-pool.ts))
- **Updating the Grok Build CLI warns about sessions in progress.** With multiple sessions now able to run at once, the *Update Grok Build CLI* action confirms before it restarts when any session is mid-turn or waiting on you — so an update doesn't silently interrupt work in a background session. ([src/sidebar.ts](../src/sidebar.ts))
- **No more long pause before Grok starts.** Sending your first message used to sit silent for 15–40 seconds before anything appeared. Behind the scenes the extension primes each session with a hidden plan-mode instruction, and that primer was running *in front of* your first message and — because Grok Build is an agentic CLI — was wandering off to read files and search the workspace before your real prompt even ran. The primer now fires **the moment a session goes live**, silently in the background, so it's almost always finished before you hit send; if you're quick, your message shows immediately and is released the instant the primer settles. The primer text itself was also trimmed to just the protocol it needs to teach (the product blurb and repo link that were tempting Grok to go exploring are gone), so it completes in a beat instead of dozens of seconds. ([src/sidebar.ts](../src/sidebar.ts), [src/grok-primer.ts](../src/grok-primer.ts), [src/session.ts](../src/session.ts))
- **A "Grokking…" indicator while you wait.** Every turn now shows an animated *Grokking…* placeholder the instant you send, so there's immediate feedback that Grok received your message — it's replaced in place the moment the first thought, reply, or tool action arrives. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))

## 1.4.7 — 2026-06-15

> Sharper math, and one-click export for equations and diagrams.

### Features

- **Math now renders with [MathJax](https://www.mathjax.org) (replacing KaTeX).** MathJax produces self-contained SVG that's closer to "real LaTeX," renders `\label`/`\ref`-style environments without painting red errors, and — crucially — gives every equation an exportable vector. Inline `\(…\)` sits on the text baseline in your editor's text color; display `\[…\]` gets its own centered, horizontally-scrollable block. The swap also fixed a double-rendering bug where Chromium drew MathJax's hidden accessibility MathML as a *second*, visible copy of each equation (`enableAssistiveMml: false`). ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts), [media/mathjax/](../media/mathjax/))
- **Copy / Download / Open actions on display math + Mermaid diagrams.** Hover any display equation or rendered diagram for a top-right overlay (mirrors the generated-image actions): **Copy** the LaTeX/Mermaid source, **Download** as an image, or **Open** it in VS Code's image preview. Download offers a quick-pick — **PNG** (rasterized with your VS Code theme background, i.e. what you see), or a **transparent SVG** tuned **for a dark** or **for a light** background. Math recolors its ink for each; Mermaid is re-rendered in its matching light/dark theme so a "for light background" diagram actually uses the light palette. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))

### Internal

- **`video-gen` is excluded from the default live-test gate** (opt-in via `--only=video-gen`). In the headless test harness grok 0.2.x spins on `/imagine-video` instead of producing a clip, so it never completes — the feature works interactively, so a default-on test only produced noise. ([scripts/live-tests.cjs](../scripts/live-tests.cjs))

## 1.4.6 — 2026-06-15

> Grok's Mermaid diagrams now render as diagrams.

### Features

- **Mermaid diagram rendering.** Grok answers with ` ```mermaid ` fenced blocks — flowcharts, sequence/state diagrams, git graphs, class diagrams, ER, pie, and more — which the chat previously showed as raw diagram source. These now render as real diagrams via the vendored **[Mermaid](https://mermaid.js.org)** library (bundled into the extension, no network — works offline and in the packaged build). The diagram is themed to match VS Code (dark/light) and gets horizontal scroll so a wide flowchart doesn't blow out the narrow sidebar. Rendering is asynchronous and DOM-based (Mermaid measures text to lay out nodes), so unlike the LaTeX path it runs as a post-render pass over the inserted message; an SVG cache keyed by the diagram source keeps the streaming bubble flicker-free (the agent message re-renders every animation frame) and stops the same diagram being laid out dozens of times before the first render resolves. A half-streamed block stays as plain text until its closing ` ``` ` arrives, and if Mermaid can't load or the diagram is malformed the readable source is shown instead of an error. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts), [media/mermaid/](../media/mermaid/))

## 1.4.5 — 2026-06-15

> Grok's math now renders as math.

### Features

- **LaTeX / math rendering.** Grok increasingly answers with TeX — inline `\(…\)` and display `\[…\]` (including `\begin{pmatrix}` matrices, fractions, sums, Greek) — which the chat previously showed as raw backslash-soup. Math is now rendered with **[KaTeX](https://katex.org)**, vendored into the extension (no network, works offline and in the packaged build). The renderer pulls LaTeX out *before* HTML-escaping so the backslashes and braces survive intact; inline math flows with the text, display math gets its own block with horizontal scroll so a wide matrix doesn't blow out the narrow sidebar. A malformed expression renders as an inline red error (KaTeX `throwOnError:false`) instead of blanking the message; if KaTeX somehow can't load, the raw TeX is shown rather than swallowed. `\label{…}` (which Grok emits inside `align`/`equation` blocks for cross-referencing) is stripped before rendering — KaTeX has no `\ref`/`\eqref` system so it would otherwise paint the label as a red error, and `\label` produces no visible output in real LaTeX anyway. Single `$…$` is deliberately **not** a delimiter — too many false positives with prose currency ("$5 and $10"). ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js), [src/sidebar.ts](../src/sidebar.ts), [media/katex/](media/katex/))

## 1.4.4 — 2026-06-15

> You can read history again while Grok is thinking.

### Fixes

- **Scrolling up no longer gets yanked back down while Grok is thinking** ([#16](https://github.com/phuryn/grok-build-vscode/issues/16)). The chat snapped to the bottom on *every* streaming update, so any attempt to scroll up and re-read earlier messages (or Grok's own earlier reasoning) was undone on the very next thought chunk. The view now follows streaming output only while you're already pinned to the bottom; the moment you scroll up to read history, auto-scroll pauses and leaves you there. Genuinely interactive activity you need to see — **permission cards**, **ask-user-question cards**, and **your own sent message** — still pulls the view back down and re-pins. This also restores the ability to keep an eye on reasoning while permission cards stack up ([#15](https://github.com/phuryn/grok-build-vscode/issues/15)). ([media/chat.js](../media/chat.js), [media/webview-helpers.js](../media/webview-helpers.js))

## 1.4.3 — 2026-06-09

> Docs catch-up and a faster, leaner session start.

### Docs

- **README rewrite.** Restructured around three audiences: users get a clean **Requirements → Install → Quick start** path, then a **Features & capabilities** section where each feature is its own collapsible — ordered by what actually sells the extension (diff-preview approval, modes, `/imagine` images+videos, voice…) rather than by implementation. **Configuration**, **Commands & keybindings**, and **Development** each collapse into a single `<details>` so the page scans in seconds while staying self-contained for the Marketplace listing. The deep dive — diagram, message flow, module map, design notes, and the Plan-Mode "the one part that isn't thin" explainer — moved to a new [docs/architecture.md](architecture.md), linked from a short *How it works* teaser.
- **Removed stale claims.** Dropped the **Subagents** feature section (still research-only — it rarely fires in practice, so it shouldn't read as shipped) and the "generated media is inlined as base64" known-limit (1.4.2 switched media to `asWebviewUri` streaming). Trimmed the opening screenshots to the sidebar + an inline `/imagine` result, with a *More screenshots* link to the folder; removed a decorative image that carried no information.
- **Canonical `README.md` / `CHANGELOG.md` casing.** The working-tree files were lowercase on disk (a Windows case-insensitivity slip) while git already tracked them uppercase; the disk now matches. (`vsce` still normalizes the *packaged* copies to lowercase inside the `.vsix` — that's its own convention, which the Marketplace renders fine.) `scripts/release.*` now reference `CHANGELOG.md` so the release-notes extraction works on case-sensitive filesystems too.

### Changed

- **The hidden plan-mode primer no longer costs a startup round-trip.** The extension sends Grok a hidden "primer" that teaches it the Plan-Mode verdict protocol. It used to fire at **every** session start — new *and* every restore — locking the composer until Grok acknowledged and burning a turn even on a session you only opened to glance at. It's now sent **lazily**, as its own hidden turn before your **first real prompt** — on a new *or* restored session — so it rides along with work you already triggered. The composer is ready the instant the session connects, and opening/abandoning a session (or restoring just to read history) costs nothing. Re-asserting the primer on the first post-restore send (rather than trusting a copy buried in replayed history, which a `/compact` can drop) keeps Plan Mode reliable across resumes. Best-effort and unchanged in protocol — the plan-gate remains the real enforcement. ([src/grok-primer.ts](../src/grok-primer.ts), [src/sidebar.ts](../src/sidebar.ts))

## 1.4.2 — 2026-06-09

> Generated video renders now, and inline media is a tighter thumbnail.

### Fixes

- **Generated videos (`/imagine-video`) finally render.** Detection, path extraction, MIME, and CSP were all already correct — the failure was the delivery: a multi-MB clip base64-inlined into a single `postMessage` `data:` URI was silently dropped, so the `<video>` got an empty source. Generated files are now served via `webview.asWebviewUri` (the grok home is a `localResourceRoots` entry), so the webview **streams the file straight from disk** instead of carrying it as a giant string — videos play, and large images load lazily. Files written outside the served roots still fall back to a base64 `data:` URI, so nothing regresses. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Polish

- **The Copy path / Open in VS Code hover icons now sit on the image.** They were anchored to the chat column's right edge, so on a thumbnail they floated in empty space well to the right of the picture. The media block is now sized to the rendered image, so the icons pin to the image's own top-right corner — for videos too. ([media/chat.css](../media/chat.css))
- **Inline media is capped at 320px wide** (was 640px), so a generation reads as a compact thumbnail in the narrow sidebar instead of dominating the chat. The file is untouched — click an image (or **Open in VS Code**) for full resolution. ([media/chat.css](../media/chat.css))

## 1.4.1 — 2026-06-09

> A two-part fix for generated images that stopped rendering in 1.4.0.

### Fixes

- **Generated images are visible again.** 1.4.0 capped inline media at 640px by wrapping it in a `width: fit-content` container. That made the `<img>`'s `max-width: 100%` resolve against an *indefinite* width, which collapses a replaced element to zero in Chromium — so every generation (including plain `/imagine`) rendered as an invisible, zero-width image. The container is now a normal block (definite width), so the percentage resolves correctly while the **640px cap stays**. ([media/chat.css](../media/chat.css))
- **Reference-edited images (`image_edit`) now render too.** Editing a real photo with `/imagine` runs Grok's **`image_edit`** tool (title `imagine-edit: …`, variant `ImageEdit`) — a surface 1.4.0's detector didn't know about, so the saved file was never inlined. Confirmed live against grok 0.2.x: the completed result reports the path as the same machine-readable JSON `{path}` the other media tools use (an extended-length `\\?\C:\…` Windows path, stripped to canonical form). `isMediaGenToolCall` now recognizes it. ([src/acp-dispatch.ts](../src/acp-dispatch.ts))

## 1.4.0 — 2026-06-08

> Two new CLI surfaces — generated image/video rendering and a Sign-Out action. The media wire format was confirmed live against grok 0.2.33 (see [research/image-generation.md](../research/image-generation.md)). Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=PawelHuryn.grok-vscode-phuryn).

### Fixes

- **Every message you send no longer renders twice (grok 0.2.33 regression).** grok **≥0.2.33 echoes the live prompt back** as a `user_message_chunk` mid-turn — 0.2.3 did not (the code's own comment read "the agent never echoes them back"). The webview already renders the bubble optimistically from `send()`, so the echo produced a **second, duplicate bubble** (and double-counted `userMessageCount`, skewing plan positioning). The host now forwards `user_message_chunk` **only during a session/load replay** (a new `replaying` flag), and the webview's `appendUserChunk` guards the same — so a live echo can never double the bubble. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))

### Image & video generation

- **Generated images and videos render inline.** When Grok generates an image (the subscription-only `/imagine`) or a video (`/imagine-video`), it now shows up as an actual image or a playable `<video>` in the chat instead of a dead tool chip. The real wire format (confirmed live, [research/image-generation.md](../research/image-generation.md)) is **not** an ACP image block — Grok's **`image_gen`** / **`image_to_video`** tools write the file into the session directory (`images/*.jpg`, `videos/*.mp4`) and report the path as a JSON string inside the completed tool result's text. The host recognizes the media-gen call, parses the path out and classifies image-vs-video by extension (`isMediaGenToolCall`/`extractGeneratedMediaPaths`), reads the file and inlines it as a `data:` URI (webviews can't load arbitrary disk paths under the CSP — `media-src data:` was added for video), and the webview renders it. Hovering an image or video reveals two top-right icons (styled like the code-block copy button): **Copy path** and **Open in VS Code** — the latter is the only way to open a *video's* file, since its click drives playback controls (clicking an image still opens its source too). Inline media is capped at **640px** on the longer edge so full-resolution generations stay legible in the chat (the file is untouched). ACP-standard image/`resource_link` blocks are also handled as a forward-compatible fallback. Both render identically on **session resume** (Grok replays the generation as a single collapsed `tool_call`). ([src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/acp.ts](../src/acp.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))

### Account

- **Sign out from the extension (#13).** New `Grok: Log Out` command (palette) and a **Sign out** item in the gear menu run `grok logout` to clear the CLI's cached credentials, tear down the live session, and drop back to the auth-required onboarding screen — no more switching to a terminal to change xAI accounts. ([src/sidebar.ts](../src/sidebar.ts), [src/extension.ts](../src/extension.ts), [package.json](../package.json), [media/chat.js](../media/chat.js))

### Keeping the CLI current

- **The Grok Build CLI is updated silently when the extension upgrades.** Grok doesn't auto-update, so a user who installs a new extension version could be left on an older CLI whose wire format the new extension no longer matches. Now, the first time a session starts after the extension's own version changes, the host runs `grok update` once before spawning the CLI — so the next handshake reports the freshly-updated version. It fires **only on an actual upgrade**, never on a fresh install (the "not-first-run" rule — a clean install just records its baseline version), at most once per activation, via `execFile` while no grok process is alive (sidesteps the Windows binary lock), and is best-effort (a failed update logs and continues on the current binary). The gate is the pure, unit-tested `extensionWasUpgraded`. ([src/cli-locator.ts](../src/cli-locator.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **The welcome status line tracks real readiness.** It now follows the true session-start lifecycle — `Updating Grok Build CLI…` (during a silent update) → `Starting…` (through the hidden primer turn, while the composer spinner is up) → `Connected · v<version>`. Previously it flipped to "connected" at the ACP handshake, *before* the primer had been sent and processed, so it claimed readiness while grok was still being primed; it now stays "Starting…" until the spinner actually clears. ([media/chat.js](../media/chat.js))

### Gear menu & status polish

- **The gear menu gets an "Other" group with About, Config & debug, and Log out.** The flat Config / Account / Debug sections collapse into two sub-views (mirroring the Model picker): **About** shows the *This extension* + *Grok Build CLI* versions, checks for a newer CLI (`grok update --check`), and offers an **Update Grok Build CLI** action; **Config & debug** holds the config links + extension logs. The on-demand update tears the session down, runs `grok update`, then **resumes the same session** on the fresh binary (preserving the conversation), showing the `Updating… → Starting… → Connected · v<new>` lifecycle. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))
- **About shows the real CLI version, even on builds the handshake doesn't tag.** The native-Windows build doesn't report a version in the ACP `initialize` response, so About used to read a bare "—" right next to a confident "CLI is up to date". It now adopts the version the update check returns (`grok update --check`'s `currentVersion`), and the action collapses to a grayed "CLI is up to date" (no button) when there's nothing to do. ([media/chat.js](../media/chat.js))
- **The Config & debug → MCP servers link works on Windows.** It used to type a quoted `"C:\…\grok.exe" mcp list` into the terminal, which PowerShell (the default Windows shell) parses as a string literal and rejects with "Unexpected token". It now launches grok directly as the terminal's own process (`shellPath`/`shellArgs` → `grok mcp list`), sidestepping shell quoting entirely. ([src/sidebar.ts](../src/sidebar.ts))
- **Transient status text animates and is capitalized.** "Starting", "Updating Grok Build CLI", "Thinking", and "Summarizing" now show an animated trailing ellipsis (a CSS `::after` so the layout doesn't shift), and the welcome line reads "Starting…" / "Connected · v…" (capitalized). ([media/chat.css](../media/chat.css), [media/chat.js](../media/chat.js))

### Tests

- New grok-free tests for v1.4.0: the `image_gen`/`image_to_video` path-in-JSON result extraction (`isMediaGenToolCall`/`extractGeneratedMediaPaths`, classifying image vs video and covering the collapsed-resume shape) and ACP-standard image fallbacks (`extractImageContent`/`collectToolImages` across inline base64, resource blob, file/remote `resource_link`) plus image-vs-text chunk routing, and happy-dom DOM tests driving the real `media/chat.js` render paths — `addGeneratedMedia` (clickable inline `<img>`, `<video controls>`, remote-link fallback, and the hover **Copy path** / **Open in VS Code** actions for both image and video). Plus the silent-update gate (`extensionWasUpgraded` — fresh-install vs upgrade vs unchanged vs downgrade) and a happy-dom suite pinning the welcome version-line lifecycle (`Updating Grok Build CLI…` → `Starting…` at the handshake → `Connected · v<version>` only when the priming spinner clears, and no reversion on later busy toggles). And the 0.2.33 regression fixes: a fake-CLI scenario that echoes a live `user_message_chunk` + a DOM test asserting a single bubble (no duplicate), and a gear-menu suite (the Other group, the About panel's versions + `grokUpdateStatus`-driven update button incl. the version-from-update-check fallback, the Config & debug links). **401 grok-free tests total.**

## 1.3.2 — 2026-06-05

- **Refreshed the Marketplace screenshot.** Updated the "alongside VS Code" README image to `v1.3.1_vscode.png` so the listing reflects the current UI. No code changes. ([README.md](README.md))

## 1.3.1 — 2026-06-05

### Fixes

- **Grok's `ask_user_question` tool works now instead of failing every time (#12).** When Grok tried to ask an inline multiple-choice question, the tool errored with `Client returned an invalid response to user question: missing field 'outcome'` and Grok fell back to dumping the question as plain text. The client had no handler for the question request (`x.ai/ask_user_question`), so it fell through to the catch-all that acknowledges unknown server requests with a bare `{}` — which Grok's deserializer rejects because the response is an internally-tagged enum that requires an `outcome` field. There's now a proper inline **question card**: each question renders its options (a single single-select question resolves on one click, like a permission card; multiple/multi-select questions let you pick then **Submit**; **Skip** dismisses), and the client replies with `{ outcome: "accepted", answers, annotations }` (or `cancelled`). The full wire format was recovered directly from the `grok.exe` binary (method name, the `AskUserQuestionExtResponse` enum, its `accepted`/`cancelled`/`skip_interview`/`chat_about_this` tags, and the `answers`/`annotations` fields) and is documented in [research/ask-user-question.md](../research/ask-user-question.md). ([src/acp.ts](../src/acp.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [media/webview-helpers.js](../media/webview-helpers.js))
- **The question card now clearly confirms your answer.** The question text under the "Grok is asking" label is prominent, and once you answer the card collapses to the question plus a bright green **✓ &lt;your choice&gt;** (for both single- and multi-select) instead of just greying out — so it's obvious Grok received it even when its reasoning continues above. **Skip** collapses to a "Skipped" state. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css))
- **Answered questions survive a session resume.** Resuming a session from history rebuilds each answered question as a read-only "You answered" card — previously the question simply vanished on reload. On replay Grok relabels the tool call's title to the display form "Ask: \<question\>" and emits one `tool_call` per question, so the card is detected by its `rawInput.questions` (robust to the relabelled title) and rendered immediately; the chosen answer is filled in when it arrives in the replay stream. Handles both agent schemas — grok-build (`ask_user_question`, `question`, quoted answer text) and the cursor/composer agent (`AskQuestion`, `prompt`, option-id answer text mapped back to labels). (If Grok's replay omits a particular answer, the question still renders without the green ✓ line.) ([media/chat.js](../media/chat.js))
- **Resuming a session whose model belongs to a different agent no longer crashes.** A session created with a Composer model (cursor agent) resumed while the default model is a grok-build one — or vice-versa — failed the whole resume with `Cannot switch to model '…': it requires agent '…' but the active agent is '…'` → `Grok exited (code null)`. A resumed session's agent is fixed by its history, so the cross-agent model can't be applied live; the resume now keeps the session's own model instead of crashing. ([src/sidebar.ts](../src/sidebar.ts))

### Tests

- 18 new grok-free tests (337 total): the pure response builders (`makeQuestionResponse`/`makeQuestionCancelledResponse`) and answer-map helper (`buildQuestionAnswers`), a happy-dom suite driving the real question card through single-click / multi-select / multi-question / Skip / the collapsed answered state / resume-restore (including the replayed "Ask: \<question\>"-titled and cursor/composer shapes), and a `SCENARIO_ASK_QUESTION` round-trip in the fake-CLI ACP integration suite asserting Grok receives a well-formed `outcome:"accepted"` reply.

## 1.3.0 — 2026-06-02

### Voice input

- **New: dictate prompts with a microphone button.** A mic button now sits in the top-right corner of the composer. Click it to record (it turns blue with animated "listening" waves), click again to stop, and the transcription is appended into the input box ready to edit and send. Transcription is powered by [xAI's Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/voice). ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))
- **Live streaming transcription (default).** Words now appear in the composer in real time as you speak, over xAI's STT WebSocket (`wss://api.x.ai/v1/stt`) — instead of only after you stop. `ffmpeg` streams raw PCM16 to the socket; the host folds the `transcript.partial` events (keyed by `start` — the trailing `transcript.done` is often empty because smart-turn finalizes mid-stream, a quirk confirmed via `research/voice-stream-probe.cjs`) into the live transcript and relays it to the webview. Falls back to one-shot batch mode via `grok.voiceStreaming: false`. Adds the extension's first runtime dependency, `ws` (tiny, zero sub-deps), bundled into the `.vsix`. ([src/voice-streamer.ts](../src/voice-streamer.ts), [src/voice.ts](../src/voice.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **Fully hands-free, continuous listening.** Saying **"grok send" submits and keeps the mic listening** — each command transparently restarts a fresh stream (so every message is one clean utterance), and you can **keep dictating the next message while Grok is responding** (mid-response messages are queued and sent the moment Grok's turn ends). After the first mic click, no mouse or keyboard is needed until you're done; the mic stops on a manual click or after ~2 minutes of silence (the ffmpeg cap). ([src/sidebar.ts](../src/sidebar.ts), [src/voice-streamer.ts](../src/voice-streamer.ts), [media/chat.js](../media/chat.js))
- **The "grok send" command is highlighted in the composer.** As you speak (or type) the phrase, the trailing occurrence is wrapped in a subtle accent pill — visible feedback that it's recognized as a command before it's consumed on send. Implemented as a backdrop overlay behind the transparent textarea (textareas can't style their own text); detection is the pure, unit-tested `trailingSendPhrase()`. Uses the configured `grok.voiceSendPhrase`. ([media/webview-helpers.js](../media/webview-helpers.js), [media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))
- **Hands-free send via "grok send".** Ending a dictation with the phrase **"grok send"** strips the phrase and auto-submits the message. The two-word default is deliberate — it won't trip on a message that merely ends in "send" (verified against real STT output) — and it's passed to the STT model as a **`keyterm` bias** so it's recognized reliably (fixing the "grok send" → "gronsent" mishearing). Configurable/disablable via `grok.voiceSendPhrase`; detection is a pure, unit-tested `parseVoiceCommand()`. ([src/voice.ts](../src/voice.ts), [src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **Why it's built the way it is.** Two hard constraints shaped the design, both verified against the real stack (see [research/voice-input.md](../research/voice-input.md) + [research/voice-probe.cjs](../research/voice-probe.cjs)): (1) the Grok CLI advertises `promptCapabilities.audio: false` and rejects audio content blocks over ACP — it's a text/code agent, so audio can't ride the CLI; and (2) VS Code webviews can't access the microphone (`getUserMedia` is blocked with no override). So capture runs in the **extension host** via an `ffmpeg` child process — the same place the CLI and terminals are spawned — and the recorded clip is POSTed straight to xAI's separate Speech-to-Text product (`api.x.ai/v1/stt`), bypassing ACP entirely. The full pipeline (DirectShow device auto-detection → mono/16 kHz capture → graceful stop → upload → transcript) was confirmed end-to-end on native Windows with `grok` 0.2.3 and ffmpeg 8.0.1. ([src/voice.ts](../src/voice.ts), [src/voice-recorder.ts](../src/voice-recorder.ts))
- **Setup.** Voice input needs `ffmpeg` on `PATH` (or `grok.ffmpegPath`) and an xAI API key. The STT API is a **separate** [console.x.ai](https://console.x.ai) developer key billed pay-as-you-go (~$0.10/hr) — distinct from the Grok CLI login, which can't authenticate against it, and unaffected by a SuperGrok subscription. Provide it via `grok.voiceApiKey`, or `GROK_VOICE_API_KEY` / `XAI_API_KEY` in the workspace `.env`. New settings: `grok.voiceApiKey`, `grok.ffmpegPath`, `grok.voiceInputDevice`. ([package.json](../package.json))
- **Discoverable setup.** When no API key is configured, the mic button shows a small "needs setup" dot and a hint tooltip (rather than only failing on click), and clicking it offers an actionable **Open Settings** / **Get a Key** prompt. A missing-`ffmpeg` error offers a jump to `grok.ffmpegPath`. The hint updates live when the relevant settings change. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [src/sidebar.ts](../src/sidebar.ts))
- **Cost, measured.** STT is billed by *audio duration*, not word count: **$0.10/hr** batch, **$0.20/hr** streaming. We measured a 510-word passage from this project's design chat → **3.06 min of audio → $0.0051 (~½¢) batch / $0.0102 streaming**, i.e. ~**1¢ per 1,000 words batch**. Method (synth → `POST api.x.ai/v1/stt` → cost from the returned `duration`) and a reusable probe are in [research/voice-cost-probe.cjs](../research/voice-cost-probe.cjs); see README § Voice input. ([README.md](README.md))
- **Startup feedback (loading state).** The mic shows a **"connecting…" spinner** while the stream spins up (~½–1s); the blue listening waves appear only once it's actually capturing — your "talk now" signal, so the first words aren't clipped. Click during "connecting" to cancel. ([media/chat.js](../media/chat.js), [media/chat.css](../media/chat.css), [media/webview-helpers.js](../media/webview-helpers.js))
- **Punctuation is preserved and de-duplicated.** The command is stripped but the sentence's own punctuation stays: "…what's the weather today grok send?" → "…what's the weather today?". When the message *already* ended in punctuation, the command's trailing mark is dropped rather than doubled — so "…mate. grok send." → "…mate." (not "…mate.."), and "…not sure. grok send?" → "…not sure." (not "…not sure.?"). At most one trailing mark, the message's own. ([src/voice.ts](../src/voice.ts))
- **Blocked sends are queued, not dropped.** "grok send" spoken while a send is blocked (Grok mid-response, or the hidden session-start primer) is queued and flushed the moment the turn ends or the session is ready. ([media/chat.js](../media/chat.js))
- **Voice listens only for the active session.** Starting a new session, resuming one from history, or a model/effort restart now hard-stops any in-progress capture and resets the mic to idle (dropping a half-spoken message or a queued "grok send"), so listening never bleeds across a session switch. ([src/sidebar.ts](../src/sidebar.ts), [media/chat.js](../media/chat.js))
- **Tests.** 85 new grok-free tests (319 total): the pure STT/ffmpeg helpers (incl. the streaming URL builder, the `start`-keyed segment accumulator, streaming ffmpeg args, `trailingSendPhrase`, send/sent tolerance, and punctuation preservation) plus happy-dom coverage of the live-streaming composer, continuous-listening queue, connecting state, and command highlight (request/response/error mapping, per-platform capture args, DirectShow device parsing, key resolution), the mic-button state machine, and a happy-dom DOM suite driving the real mic button through the record → transcribe → insert → error-reset lifecycle. The live STT round-trip stays a manual probe ([research/voice-stt-probe.cjs](../research/voice-stt-probe.cjs), [research/voice-e2e-verify.cjs](../research/voice-e2e-verify.cjs)) per the grok-free CI convention.

## 1.2.4 — 2026-06-01

### Model switching

- **Switching to a model bound to a different agent now works instead of erroring.** Picking a model whose agent type differs from the running session — e.g. the Composer models, which belong to the CLI's `cursor` agent rather than `grok-build` — failed with `Cannot switch to model '…': it requires agent 'cursor' but the active agent is 'grok-build-plan'. Start a new session to use this model.` The CLI binds the agent at spawn and locks it after the first turn (including our hidden primer), so a live `session/set_model` can only stay within the same agent. The fix mirrors the reasoning-effort flow: the chosen model is persisted to `grok.defaultModel` and the session restarts, where `newSession` re-applies it *before* the primer runs — while the agent is still rebindable (verified against grok 0.2.3 in `research/*.cjs`). With no user history yet the restart is transparent; with history you get the same **Summarize & Restart** / **Just Restart** prompt as an effort change. Same-agent switches still happen live with history intact. ([src/sidebar.ts](../src/sidebar.ts), [src/acp-dispatch.ts](../src/acp-dispatch.ts))
- **Model/effort changes are locked while the session is starting.** A model switch fired during the hidden-primer window raced that turn: a probe showed `session/set_model` sometimes lands *before* the agent locks (applied live) and sometimes *after* (rejected → restart), so switching on a fresh-looking empty session would intermittently appear to "do nothing". The model button and effort dots are now disabled while a turn is in flight or the session is priming — the same `busy` signal that disables send/submit — and the host ignores model/effort messages that slip through the start window. The control re-enables the moment the session is ready. ([media/chat.js](../media/chat.js), [src/sidebar.ts](../src/sidebar.ts))

### UI

- **The model button shows the user-facing name everywhere.** The gear popover's model button showed the raw model ID (`grok-build`) while the dropdown showed the friendly name (`Grok Build`). Both now resolve through a pure `modelDisplayName()` helper, falling back to the ID only when a model has no name. ([media/webview-helpers.js](../media/webview-helpers.js), [media/chat.js](../media/chat.js))

## 1.2.3 — 2026-05-30

### Plan mode

- **Grok's own `plan.md` write no longer blocked when the home directory is the workspace.** The plan-mode write gate exempts grok's CLI-owned `~/.grok/sessions/.../plan.md` so it can be written and snooped during planning, but the exemption previously relied on that file living *outside* the workspace — true for project workspaces, false when the user opens their home directory as the workspace root. There the plan file resolved inside the containment root and the workspace block won, so planning stalled (repeated `fs/read_text_file`/`fs/write_text_file` errors, then `session/prompt` timeout). `shouldBlockWrite` now exempts a plan-file write only when it also resolves under the resolved grok home (`~/.grok`), so home-as-workspace plan writes are allowed while real workspace writes — and an arbitrary project-local `.grok/sessions/.../plan.md` that isn't grok's own — stay blocked. (#10, #11, thanks @shugav)

## 1.2.2 — 2026-05-29

### Plan mode

- **Plan-mode gate hardening.** Relative workspace write paths are now resolved against the workspace root before containment checks, and common mutating forms of otherwise read-only-looking commands (shell separators/newlines, command-executing heads like `env`/`awk`/`sed`, write/exec flags on `find`/`fd`/`sort`/`tree`, mutating Git forms, and `npm audit --fix`) are blocked before plan approval. Grok's own `.grok/sessions/.../plan.md` write stays allowed and snooped. (#5, #6, thanks @shugav)

### Reasoning effort

- **`grok.defaultEffort` no longer crashes startup — and effort forwarding still works.** The `Grok exited (code 2)` crash was a value mismatch, not a protocol limitation: the picker offered `max`, which the grok CLI doesn't have (it accepts `none, minimal, low, medium, high, xhigh`). Fixed by aligning the offered values to grok's real set — dropped the bogus `max`, added `none`/`minimal`. `--reasoning-effort` is still forwarded (before the `stdio` subcommand, where the agent-level flag belongs) and changing effort still restarts the session. A pure `buildGrokAgentArgs()` helper + a fake-CLI startup test pin the arg shape. (#3, #4, thanks @shugav for the report)

### Plan review

- **Open a plan as a Markdown editor tab.** Live and restored plan cards now show a link that opens the plan text in a normal VS Code editor (an extension-owned snapshot — deliberately *not* grok's CLI-owned `.grok/sessions/.../plan.md`). Opening it doesn't send a verdict, disable the approval controls, or clear typed feedback. Better for reviewing long plans. (#7, #8, thanks @shugav)

## 1.2.1 — 2026-05-29

Robustness fixes from a static audit (cross-checked with Codex). The high-impact ones are in the child-process supervision layer; a few low-impact correctness/perf cleanups ride along. Findings judged overstated or cosmetic (e.g. the non-`file://` URI drop) were left as-is.

### Fixes

- **Responding to the CLI after it exits no longer crashes the extension host.** `respondPermission` / `respondExitPlan` / `cancel` / the internal request + response writers all did a bare `this.proc?.stdin.write(...)`. The `exit` handler never cleared `this.proc`, so after the CLI died the optional-chaining check still passed and the write hit a destroyed pipe — throwing `ERR_STREAM_DESTROYED` synchronously, or emitting an async `'error'` with no listener, either of which became an uncaught exception in the host. Real trigger: clicking Approve/Reject/Cancel (or a late `terminal/output` ack) after the CLI has crashed. All writes now route through a single `writeLine()` helper that checks `stdin.writable` and try/catches; `start()` registers a `stdin` `'error'` listener; the `exit` handler drops `this.proc` so later writes are skipped; `dispose()`'s `kill()` is wrapped (it can throw `EPERM` on Windows if the process already exited). ([src/acp.ts](../src/acp.ts))
- **Killed terminal commands are no longer reported as a clean exit.** A process terminated by a signal reports `code === null`; the old `code ?? 0` masked that as exit code `0`, so the agent assumed an interrupted command had succeeded. Signal kills now map to the shell convention `128 + signum` (SIGTERM → 143) via a new pure `resolveExitCode()` helper. The same `exit` handler also no longer clobbers an exit code already set by the `spawn` `'error'` handler. ([src/terminal-manager.ts](../src/terminal-manager.ts))
- **Windows: killing a terminal now kills the whole process tree.** With `shell: true`, `spawn` wraps the command in `cmd.exe`; `proc.kill("SIGTERM")` only terminated that wrapper, orphaning long-running descendants (`npm`, `node`, …) that held file locks and blocked subsequent grok runs. `kill()` now uses `taskkill /pid <pid> /T /F` (via `execFile`, no shell) on Windows through a new pure `buildKillPlan()` helper; POSIX keeps the direct signal. ([src/terminal-manager.ts](../src/terminal-manager.ts))
- **Terminal output no longer corrupts multi-byte UTF-8 at a buffer boundary.** Output was decoded with `Buffer.toString()` per chunk, so a character split across the truncation point (or across two stream chunks) became a replacement char (`�`) — visible for any non-ASCII output (emoji, i18n text, localized Windows paths). Each terminal now decodes through a `StringDecoder` that buffers incomplete sequences across boundaries. ([src/terminal-manager.ts](../src/terminal-manager.ts))
- **Per-request ACP timers are cleared on response.** Each `request()` armed a `setTimeout` (30 min for prompts) that was never cleared on success — the resolved request left a live timer and its closure pending until it fired and no-op'd. Timers are now tracked on the pending entry and cleared on response and on process exit. ([src/acp.ts](../src/acp.ts))
- **`#` in file paths (C#/F# folders) now parses correctly.** The "open file" ref parser used `[^#]+`, so a path with a `#` followed by a real `#L<n>` line suffix failed the match and fell through to opening the literal (wrong) path. Parsing moved to a pure `parseFileRef()` that anchors the `#L…` fragment to the end of the string. ([src/file-ref.ts](../src/file-ref.ts))
- **Dropping a huge file with Shift no longer freezes the window.** Shift-drop read the entire file synchronously just to count lines; a multi-MB log stalled the host (and a 500 MB file could OOM it). Files over 10 MB now skip the line count and fall back to a no-selection chip. ([src/file-ref.ts](../src/file-ref.ts), [src/sidebar.ts](../src/sidebar.ts))

### UI / session fixes (live-testing pass)

Surfaced while smoke-testing the rebuilt extension:

- **"No session" error when sending before the session finished loading.** The composer was interactive during the whole `start()` + `session/new` window; sending then hit `prompt()`'s `sessionId` guard and surfaced a "no session" bubble. The composer is now **locked (spinner, disabled) for the entire session-start window** — not just the priming step — and cleared on every start outcome (ready, missing-CLI, error). ([src/sidebar.ts](../src/sidebar.ts))
- **Plan-verdict protocol markers no longer leak into restored conversations.** The host prepends `[Plan approved|rejected|cancelled]` to the wire-level prompt for grok's benefit; live hid it, but on resume grok replayed the raw text and the marker showed in the user bubble. Replayed verdict messages now strip the marker; a **marker-only verdict** (no comment) renders no user bubble at all (matching live), while grok's reply to it still shows. ([media/chat.js](../media/chat.js))
- **Restored plan cards land in the right place.** A marker-only verdict was counted as a user message on replay but never counted live, desyncing the saved `afterUserMessage` positions so cards drifted to the bottom. Marker-only verdicts are no longer counted on replay, re-aligning positions with what the host persisted. ([media/chat.js](../media/chat.js))
- **Live plan card now matches the (nicer) restored look.** After picking a verdict, the live card drops its buttons + comment box and shows a single colored verdict label (`Approved`/`Rejected`/`Cancelled`), instead of leaving greyed-out buttons and an uncolored label. ([media/chat.js](../media/chat.js))
- **Can't delete the active session from history.** Deleting the live session didn't stick (the CLI re-persists it); the delete button is now hidden for the active row (rename still available). ([media/chat.js](../media/chat.js))

### Testing — 204 tests

- New regression tests cover each fix, written to fail before the fix landed (TDD). Process layer: `writeLine` swallows a throwing/destroyed stdin and skips a non-writable pipe ([test/acp-integration.test.ts](../test/acp-integration.test.ts)); `resolveExitCode` maps signals to `128 + signum` and passes real codes (incl. 0) through; a killed process surfaces a non-zero exit; `buildKillPlan` issues `taskkill /T /F` on Windows and `SIGTERM` on POSIX; truncating mid-character emits no `�` ([test/terminal-manager.test.ts](../test/terminal-manager.test.ts)); a resolved `request()` leaves no armed timer ([test/acp.test.ts](../test/acp.test.ts)). Pure path helpers: `parseFileRef` / `shouldReadFileInline` ([test/file-ref.test.ts](../test/file-ref.test.ts)). Webview: marker stripping + marker-only suppression + position alignment on replay, the collapsed live verdict card, and delete hidden for the active session ([test/plan-history-restore.dom.test.ts](../test/plan-history-restore.dom.test.ts), [test/plan-card.dom.test.ts](../test/plan-card.dom.test.ts), [test/webview-ui.dom.test.ts](../test/webview-ui.dom.test.ts)).
- **Flaky CI fix.** `test/acp-integration.test.ts` shared one `stderr` array binding across tests, so a prior test's late stderr could bleed into the next (reliably failed `gate blocks fs/write` on Linux). Each test now captures into its own array, listeners are removed in `afterEach`, and the stderr assertion waits for its line (stderr lags the stdout response across pipes). Reproduced on Ubuntu via Docker before fixing.
## 1.2.0 — 2026-05-28

### Plan mode is now enabled

The headline of this release reverses 1.1.0's "Plan mode stays disabled." The `x.ai/exit_plan_mode` ACP path is still broken in `grok` 0.2.3 — it treats *any* client response (result **or** error) as approval, so a plan can't be rejected at the protocol layer. Rather than wait on the CLI, this build **enforces plan mode client-side**, mirroring how YOLO mode is implemented.

- **Client-side plan gate ([src/plan-gate.ts](../src/plan-gate.ts), pure + unit-tested).** While a plan is active, the extension blocks the two *mandatory* server→client choke points the agent cannot avoid:
  - `fs/write_text_file` — refused when the path resolves **inside the workspace** (grok's own `~/.grok/sessions/<cwd>/<id>/plan.md` lands *outside* the workspace, so it's allowed — and snooped to recover the plan text, since `exit_plan_mode` arrives with `planContent: null`).
  - `terminal/create` — refused unless the command is on a conservative **read-only allowlist**. The classifier is pipe-aware: a pipeline passes only if *every* `|`-separated stage is independently read-only, and shell metacharacters that chain, redirect, or smuggle code (`>`, `;`, `&&`, `` ` ``, `$(`, `{ }`) block it outright. The allowlist covers **read-only PowerShell pipelines** (`Get-ChildItem | Select-Object …`, `Get-Content`, `Test-Path`, etc.) for native Windows, while excluding anything that writes or executes (`Out-File`, `Set-Content`, `Invoke-Expression`/`iex`, `ForEach-Object`, `Where-Object`).
- **Asymmetric mode sync.** Entering plan mode *any* way (including an agent-initiated `current_mode_update: plan`) raises the gate; it's lowered only by explicit user action, never by the CLI's mode flapping (the false-approve emits `current_mode_update: default`, which is deliberately ignored).
- **Mode picker copy updated.** Plan mode is no longer marked disabled; its description now reads "Grok explores and proposes a plan; file writes and commands are blocked until you approve it." Matched in the README modes table and command list.

### Three-verdict plan review (Approve / Reject / Cancel)

The plan-review card now offers three distinct outcomes, each mapped to a different ACP verdict and different downstream behavior. (Earlier in the iteration this was a two-button Approve / Keep planning UI; user testing surfaced that "I want to stop planning but not implement" had no clean exit, so we split it.)

- **Approve & implement** → verdict `approved`. Drops the gate, returns the CLI to act mode, sends "Implement it now" as the next prompt.
- **Reject** (with optional comment) → verdict `rejected`. Keeps the gate up — you're still in Plan mode. If you wrote a comment, it's sent to Grok as a plain user message (not "revise the plan"); Grok decides whether to re-plan or answer. The chosen button highlights, a **Rejected** label appears.
- **Cancel** → verdict `abandoned`. Drops the gate, switches the CLI back to act mode, sends nothing. Use this to back out of planning entirely. **Cancelled** label appears.

### Suppressing the CLI's false-approval response

Because grok 0.2.3 treats any `exit_plan_mode` response as approval, rejecting a plan would otherwise let the agent keep streaming "OK, the plan is approved, here's what I'll do…" before our follow-up prompt landed. On Reject / Cancel we now:

1. Send the verdict to the CLI (it still mis-interprets it, but that's fine — the gate is authoritative).
2. Immediately send `session/cancel` to interrupt the in-flight prompt.
3. Set a content-only suppression flag (`suppressPlanReject`) that drops `messageChunk` / `thoughtChunk` / `toolCall` events for the rest of the turn — but **not** `promptComplete` / `agentEnd`, so the webview's `busy` state still clears and the send button re-enables when the cancelled turn ends.
4. Post `agentReset` to the webview, which removes the in-flight agent bubble from the DOM so the false-approval text never reaches the screen.

A `finally` in `handleSend` clears the suppression as a safety net so it can't get stuck.

### Plan markdown rendering

Plan bodies render through the same Markdown pipeline as agent messages now (headings, lists, code fences) instead of monospace `<pre>` blocks. Applies to both the live review card and the restored history cards. A bug along the way: the `.code-block` `position: relative` rule was scoped under `.msg.agent .body`, so when plan cards contained fenced code their absolutely-positioned copy buttons escaped to the viewport and overlapped the Session-history / New-session header buttons. The scoping was loosened so any `.code-block` is its own positioning context.

### Per-session plan history (restored inline, not at the bottom)

grok overwrites `~/.grok/sessions/<…>/plan.md` every time the agent proposes a new plan, so older plans in a session are physically gone from disk. We now persist each resolved plan to VS Code's `globalState` keyed by session id (`SessionMetaOverride.plans`), capturing **text + verdict + `afterUserMessage`** (the count of user messages already sent at the moment of resolution).

On session resume:

- The host posts a `planHistoryQueue` to the webview *before* `session/load` starts.
- The webview drains the queue inline as the replay streams: each plan card lands at its saved user-message boundary (right where the plan actually happened), not in a clump at the bottom. Legacy entries without a saved position fall back to the end of replay.
- The plan-gate state is restored from the *last* verdict via a pure helper ([src/plan-restore.ts](../src/plan-restore.ts)): `rejected` → re-raise the gate (you were mid-planning); `approved` / `abandoned` / no log → leave the gate down (Cancel-then-restore no longer comes back stuck in Plan mode). Without this, the CLI's replayed `current_mode_update` events would raise the gate even when the user had cancelled.
- A separate `pendingPlanText` field holds the displayed plan from render → verdict-click, since `lastPlanText` is cleared the moment the card renders. (Regression: without this, restored plans showed `"(empty plan)"` despite content being persisted.)

### Native-Windows webview fixes (carried forward + locked in)

The history-popover, whole-row-click, and reasoning-trace-expand fixes from 1.1.0 are now covered by DOM tests so they can't silently regress again (see Testing).

### Testing — 178 tests, all grok-free

- **Two clearly separated tiers.** `npm test` (and CI) runs **only grok-free tests** — pure-logic unit tests plus DOM tests that drive the real `media/chat.js` in a headless `happy-dom` window. The **grok-dependent probes** live in `research/*.cjs`, require the `grok` binary, are run manually, and are never collected by Vitest or CI.
- **New pure module + tests** for the persist / restore decision: [src/plan-restore.ts](../src/plan-restore.ts) extracts `appendPlanEntry` and `decideRestoreState`. 15 tests cover chronological append, immutability, text preservation (the wiped-`lastPlanText` regression), and the verdict-driven restore decision for every verdict including the "rejects then cancels → Agent mode" case that previously came back in Plan mode.
- **New DOM tests** in `test/plan-history-restore.dom.test.ts` (12 tests) lock in the restore-flow rendering: positioned plans interleave at the right boundary, legacy plans flush at end of replay, multiple plans at the same position drain together, live user message drains queued plans, `clearMessages` resets queue + counter, all three verdict buttons produce matching status labels, `agentReset` removes the in-flight agent bubble and a subsequent `messageChunk` creates a fresh one.
- **New ACP integration tests** in `test/acp-integration.test.ts` (6 tests) drive the real `AcpClient` over JSON-RPC stdio against a ~150-line fake `grok agent stdio` fixture (`test/fixtures/fake-grok-acp.cjs`). Covers the wire layer + plan-mode gate end-to-end: plan-snoop, workspace-write gate (on and off), terminal-create gate for mutating vs read-only commands. Encodes only what ACP requires, not grok's version-specific quirks, so it stays stable across CLI bumps.
- **178 tests, ~1.4s**, no network, no spawned `grok`. The whole suite runs on a clean Ubuntu CI runner via `.github/workflows/ci.yml`.

### Bug fixes (this iteration)

- **Effort-picker dots are now visually balanced.** The "filled / empty" dots used the `●` / `○` Unicode glyphs, which render at different sizes in most fonts (the empty one is visibly larger). Replaced with CSS-shaped spans so active and inactive states are the same diameter.
- **Spawning `.cmd` / `.bat` CLI paths now works on Windows.** Node 18+ refuses to spawn those without `shell: true` (CVE-2024-27980). `AcpClient.start()` now detects them and sets `shell: true` automatically, so installs that resolve grok to a `.cmd` shim (or the test fake-CLI) start correctly.

## 1.1.0 — 2026-05-27

### Windows support

- **Native Windows is now first-class.** xAI shipped a native Windows build of the `grok` CLI (`irm https://x.ai/cli/install.ps1 | iex`), so the extension no longer needs WSL. This reverses the 1.0.3 "Windows isn't supported" onboarding panel.
  - **Onboarding** now detects Windows and shows the PowerShell install command (`irm https://x.ai/cli/install.ps1 | iex`) with copy-to-clipboard and "Open terminal & run" — the same flow macOS/Linux already had, just with the right command per platform.
  - **"Open terminal & run"** sends the PowerShell installer on Windows and the `curl | bash` installer elsewhere. The CLI locator (`grok.cmd`/`grok.exe`) and headless terminal manager (`shell:true`) already worked cross-platform.
- **README + CLAUDE.md** updated: platforms now read "macOS, Linux, and Windows"; install steps show both the bash and PowerShell one-liners; build-from-source and uninstall lines note the `scripts\*.ps1` equivalents.

### Webview UI

Surfaced by the first native-Windows smoke test (against `grok` 0.2.3):

- **Session-history popover now hides.** `.history-popover` set `display:flex`, which beat the UA `[hidden]{display:none}` rule (author styles win), so the dropdown rendered as an empty box on startup and `hidden = true` could never dismiss it. A `.toolbar-popover[hidden] { display:none }` rule restores correct hide behavior — the popover now closes on select, click-outside, and new-session.
- **Whole history row is clickable.** Resume was wired only to the name label even though the row showed a pointer cursor; the handler moved to the row, so clicking anywhere on it (name, meta line, or padding) resumes. Rename/delete buttons keep their own `stopPropagation`.
- **Reasoning traces are expandable again.** The "Thinking…/Thought for *N*s" line is once more a collapsible header — click it to reveal the full trace (collapsed by default, rAF-coalesced while streaming). This reverses the 1.0.2 change that discarded the trace at the render layer.
- **Decluttered welcome screen.** Removed the static tips list (Enter to send / slash commands / file chips) from the empty-session screen.
- **Restored user prompts when loading a session.** `session/load` replays history as session updates, but `user_message_chunk` had no route, so replayed user prompts fell through to the ignored generic-update branch and vanished — loaded sessions showed only the agent's half of the conversation. The chunk is now routed and rendered into a user bubble, with the in-flight agent turn committed at each user boundary. Replayed reasoning headers read "Thought" (no elapsed time, since the original timing isn't in the replay stream); live turns keep "Thought for *N*s".
- **Inline diffs render as diffs.** Fenced ` ```diff ` blocks now color added lines green and removed lines red using VS Code's own `diffEditor` *line* backgrounds (so they match the editor's diff view), dim hunk/metadata lines, and wrap long lines instead of forcing horizontal scroll. Copy still yields plain diff text (the handler reads `innerText`, since each row is now a block-level span).
- **Copy-code button no longer fights the text.** It fades to 0.95 opacity on code-block hover and full opacity on button hover, so its background stays solid instead of blending into the first line of code.

### Mode picker

- **Agent-mode description corrected.** As of `grok` 0.2.3, Agent mode acts directly and only prompts for changes it judges sensitive; the picker no longer claims it "asks for approval before making each change." Matched in the README modes table.
- **Plan-mode note de-emphasized.** The "Reject / Abandon not yet supported" note under disabled Plan mode is now muted gray (`descriptionForeground`) instead of warning yellow — it's an explanation, not an alert.

### Verified (no change)

- **Plan mode stays disabled.** Re-tested the `x.ai/exit_plan_mode` rejection path live against `grok` 0.2.3 over ACP: rejecting a plan with a JSON-RPC error still let the agent exit plan mode and execute the whole plan (it created the target file anyway). The CLI bug from the 0.1.x baseline is unchanged, so the Plan UI remains off.

## 1.0.3 — 2026-05-19

### Tool calls

- **In-progress group header** now shows only the current action in present-progressive form with three animated dots — *Reading CLAUDE.md*, *Listing root folder*, *Running command*, *Searching web*, *Editing chat.js*. Previous behavior accumulated `"X, Y +N"` as new calls streamed in.
- **Completed multi-call summaries** are now categorical instead of listing the first two calls: *Explored N items, searched web, ran N commands*. Reads and directory listings roll into "explored"; web search/fetch into "searched web" (no number); everything else into "ran N commands".
- **Chevron moved to the right** of the label and only appears on hover; rotates 90° when expanded.
- **Friendlier detail labels** — `web_search` → *Web search*, `List .` → *List root folder*.

### Markdown rendering

- **Tighter heading and list spacing.** Headings and lists no longer get a phantom `<br><br>` stacked on top of their own CSS margin when preceded by a blank line. Block elements rely on their margins; only paragraph-to-paragraph transitions emit a `<br><br>`.

### Message layout

- **User bubble min-width 40%.** Short prompts no longer collapse to a text-width sliver against the right edge.
- **Show more / Show less hover** flips to a full-contrast inverted pair (`foreground` on `editor-background`) instead of the semi-transparent secondary-button hover. Reads as a solid pill.

### Performance

- **Streaming rAF-coalesced.** `agent_message_chunk` and `agent_thought_chunk` no longer trigger a full markdown re-render per chunk. Updates batch into one paint per animation frame, with a synchronous flush on `promptComplete` so the final chunks always land. Long responses no longer jank.

### Cleanup

- **Removed dead `grok.defaultPermissionMode` setting** that was declared in `package.json` but never read by any code.
- **`activationEvents` dropped** — modern VS Code auto-generates activation from the view contribution, so the explicit entry is redundant (linter-flagged).

### Docs

- **README restructured** for a dev-reading audience. New top-level sections: *Why an extension, not the CLI?*, *Key concepts* (where state lives, modes, chips, permission cards), *Architecture* (diagram + session lifecycle + module map + design choices), *Development*. Slash-command tables moved to `docs/SLASH-COMMANDS.md`. Marketplace install promoted; stale 1.0.1 VSIX path removed.
- **package.json `description`** rewritten to lead with the "thin ACP client" framing instead of a feature laundry list. Added keywords: `agent-client-protocol`, `acp-client`, `xai-grok`.

### Fixes

- **Shell-set `XAI_API_KEY` now works.** Previously the alias to `GROK_CODE_XAI_API_KEY` (which the CLI actually reads) only fired for keys loaded from a workspace `.env`. Keys in the user's shell environment are now mapped too, matching what the README documents.
- **Broader auth-error detection.** The auth-required onboarding panel now triggers on 401/403/`forbidden`/`api_key`/`credential` errors as well as anything containing `auth`. Reduces the chance of users seeing a generic "Failed to start Grok" toast when the real cause is missing or invalid credentials.

### Onboarding

- **Windows shows an honest "not supported" panel.** Native Windows users no longer get the macOS/Linux `curl | bash` install command (which can't run in cmd/PowerShell). They get a clear note pointing to the README's WSL workaround.
- **"SuperGrok Heavy" labeling.** The auth panel now names the *Heavy* tier explicitly (which is what carries the Grok Build entitlement) instead of the ambiguous "SuperGrok subscription".

### Distribution

- **Removed precompiled `.vsix` files** from `releases/`. They were drifting from `main` and the README's quick-install line pointed at the stale 1.0.1 build (which lacked the new onboarding UI). The marketplace listing is the canonical install path; build-from-source remains supported for development.

---

## 1.0.2 — 2026-05-19

### Markdown rendering

- **Header hierarchy** — H1 / H2 / H3 now scale visibly above body text (1.4em / 1.25em / 1.1em). Previously every heading rendered at body size, just bold.
- **Body rhythm** — agent message bodies use `line-height: 1.55` for easier scanning; first-child headings drop their top margin to avoid awkward leading gaps.
- **Nested bullet markers** — disc → circle → square at three depths (was disc → circle only).
- **GFM tables** — pipe tables with `|---|---|` separator rows now render as bordered tables with bold tinted header rows and per-column alignment (`:---`, `:---:`, `---:`). Wrapped in an `overflow-x: auto` container so wide tables get a horizontal scrollbar instead of breaking layout.

### Code blocks

- **Copy code button** — fenced code blocks now show a hover-revealed "Copy code" button in the top-right corner. Click writes the code (raw text, no formatting) to the clipboard and flashes a checkmark for 1.5 s.

### Message layout

- **User messages as bubbles** — right-aligned, capped at 80 % width, no border, lighter `editorWidget-background` tint. Inline `YOU` / `GROK` role labels removed; position alone signals sender.
- **Per-message actions** — every user and agent message shows a hover-revealed action row at the bottom: timestamp (`6:47 AM`) and a copy-message button that copies the raw markdown.
- **Show more / Show less** — restyled to match the secondary-button family (proper padding, button background). Hover-reveal behavior unchanged.

### Thinking traces

- **Reasoning hidden by design** — the "Thinking..." indicator stays as a single line at standard text size; on completion it flips to "Thought for *N*s". The actual trace text is discarded at the webview rendering layer (never enters the DOM) instead of being collapsed behind a chevron — there's no expansion affordance.

### Onboarding

- **In-sidebar onboarding** — the missing-CLI and authentication-required errors no longer pop modal VS Code dialogs. The welcome panel itself swaps to an onboarding state:
  - **Missing CLI** — shows the install command (`curl -fsSL https://x.ai/cli/install.sh | bash`) with copy-to-clipboard and an "Open terminal & run" button, plus a "Re-check connection" button.
  - **Auth required** — explains the two paths: SuperGrok subscription (run `grok /login` in a terminal) or API key from [console.x.ai](https://console.x.ai) with `XAI_API_KEY` in a workspace `.env`. Same "Re-check connection" hand-off.
  - All onboarding is deterministic — no AI calls happen before the CLI is reachable.
- **Welcome on every new session** — clicking the new-session button now restores the welcome panel (logo, byline, version, tips) instead of leaving an empty pane. Previously the welcome only appeared on first activation.

### Docs

- README now points to [console.x.ai](https://console.x.ai) as the place to obtain an API key, alongside the existing `grok /login` flow.

---

## 1.0.0 — 2026-05-18

### UI / UX

- **Mode labels** — mode button now shows "Agent mode" / "Plan mode" (YOLO unchanged) in both the button and the picker. The button collapses to icon-only when the sidebar is narrow.
- **Context donut** — label changed from a percentage to `usedK/maxK` format (e.g. `20K/200K`) so the scale adapts to the model's context window. Tooltip shows exact token counts.
- **Settings gear — Model and Effort** — added "Model and Effort" section header above the model+effort row; removed the sparkle icon from the model name button; model name font now matches the rest of the popover (13 px); fixed double-border between the model row and the Session section.
- **Effort dots** — increased dot size (10 px → 14 px); each dot now shows a descriptive tooltip ("Low — fast, lightweight reasoning", etc.).
- **Summarize & Restart** — when changing reasoning effort with an active conversation, a VS Code dialog offers *Summarize & Restart* or *Just Restart*. The summarize path sends a silent summary request to the current session, starts a fresh session with the new effort level, injects the summary as context (suppressed from the chat UI), and shows a "Context from previous session applied" banner. The original Grok summary response is hidden — only the banner appears.

### Fixes

- Resolved race condition where changing effort (or clicking New Session) showed "Grok exited (code 143)" errors from the previous session's process being disposed. Each session now carries a generation counter; `exit` events and errors from replaced sessions are suppressed.
- `--reasoning-effort` flag was never actually passed to the spawned process. Fixed — the flag is now read from `grok.defaultEffort` and forwarded on every session start.

---

## 0.9.0 — 2026-05-18

### UI / UX

- **Bottom toolbar** — removed the top bar entirely; model, mode, gear, and new-session controls now live in a responsive row at the bottom of the composer, next to the send button. The row shrinks gracefully to icon-only when the sidebar is narrow (labels disappear, icons stay).
- **Mode selector redesign** — each mode now has a distinct icon and a one-line description (Claude Code-style popover). Agent uses a shield icon, Plan uses a list-tree icon, YOLO uses a lightning bolt.
- **Collapsible user messages** — messages taller than ~3 lines collapse automatically with a gradient fade. "Show more" appears on hover; "Show less" collapses back.
- **Tool call display** — single tool calls render as a flat row with a human-readable label ("Read sidebar.ts", "Edit package.json", "Run npm test"). Multiple calls from one agent step collapse into a grouped header ("Read, Edit +2") that expands on click.
- **Welcome screen** — xAI Grok mark logo (white), "Grok Build" title, "by Pawel Huryn (The Product Compass)" byline.

### Features

- **Reasoning effort** — configurable from the gear popover (CLI default | Low | Medium | High | XHigh | Max). Changing effort restarts the session so the new flag takes effect. Also exposed as `grok.defaultEffort` VS Code setting.
- **YOLO mode** — auto-approves all permission requests in the extension without any CLI restart. Session and memory are fully preserved; switching back to Agent or Plan mode re-enables approval cards immediately.
- **Gear / settings popover** — single gear icon opens a panel with three sections:
  - *Session*: Reasoning Effort picker, Compact conversation shortcut
  - *Config*: Open global config (`~/.grok/config.toml`), Open project config (`.grok/config.toml`), List MCP servers in a terminal
  - *Debug*: Show extension logs
- **MCP server support** — the extension passes `mcpServers: []` in `session/new` (the CLI rejects the call without this field), and the CLI loads its own MCP configuration from `~/.grok/config.toml` / `.grok/config.toml` alongside that empty list. Configure servers via `grok mcp add` or by editing the config files directly.

### Fixes

- Removed `--reasoning-effort high` default that was causing 403 errors on free/SuperGrok accounts (the flag is unsupported in stdio mode on some subscription tiers).
- Removed stale `hint` element references that caused silent JS errors in the webview.
- Popovers now position themselves above their trigger button (correct for a bottom toolbar) and clamp to stay within the panel width.

---

## 0.1.0 — unreleased

Initial preview. ACP client for `grok agent stdio`.

### Implemented

- Sidebar chat webview driven by `grok agent stdio` over ACP
- Streaming agent messages + separate thinking trace (collapsible, shows elapsed time)
- Permission-request cards with diff-editor preview (allow always / allow once / reject)
- Plan-mode toggle (`session/set_mode`) + plan-approval cards (`x.ai/exit_plan_mode`)
- Model picker (live `session/set_model`)
- Slash-command autocomplete sourced from `available_commands_update`
- Context-usage donut from prompt result `_meta.totalTokens`
- File chips with hide-toggle, Explorer drag-and-drop (Shift = embed inline)
- Right-click "Grok: Send File / Selection" in Explorer + editor
- `Ctrl+;` opens sidebar; `Alt+G` inserts @-mention for active file
- Required server→client handlers: `fs/read_text_file`, `fs/write_text_file`, `terminal/{create,output,wait_for_exit,kill,release}`
