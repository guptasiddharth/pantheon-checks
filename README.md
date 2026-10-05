# pantheon-checks

Checks that [`@join-pantheon/cli`](https://www.npmjs.com/package/@join-pantheon/cli)
works for a new person on real Windows, macOS and Linux machines, on Node 22 and 24.

`journey.mjs` installs the published package and walks through what someone joining
a team does: sign up, start or join a team, send a message, have their coding
agent start Pantheon, run the wake-up hook, and run `pantheon doctor`. It uses
throwaway homes and a relay started on the runner, so it touches no real account
or hosted service.

Run it from the **Actions** tab ("journey" → Run workflow) with a version or tag:
`latest`, `next`, or an exact version such as `0.31.2-rc.1`.

`desktop.mjs` ("desktop" workflow) checks what runs in the background and on screen:
on Windows the per-user Task Scheduler task, the hidden host with its worker,
notifier and tray, an alert going through the tray, toasts switched on and a real
toast found in Windows' own history with its buttons, its Done link activated through
the shell, Windows Defender scanning the launcher, scripts, node.exe and package,
`pantheon://` links, `stop all` and `uninstall`; on Linux alerts over D-Bus with Done
and Open board buttons (a session bus with a stand-in notification server, and the
real `dunst` on Xvfb, Done chosen from dunst's own menu), `doctor`, and the systemd
--user unit; everywhere the local board. Each check prints ok,
FAIL or NOT RUN with the reason a runner could not do it.

Pantheon's own source and full test suite live elsewhere; this repository only
checks the package as it is published.
