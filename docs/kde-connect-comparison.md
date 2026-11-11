# PowerBin and KDE Connect

Research checked 2026-11-10 against official KDE documentation and source. PowerBin
behavior is drawn from this repository; platform builds and runtime validation
have different coverage, recorded in the [migration validation](tsx-migration-validation.md).

KDE Connect already solves much of the everyday “move text between my devices”
problem. PowerBin’s useful distinction is its retained, self-hosted text relay:
saved snippets, delayed delivery, and one-use browser links. KDE Connect is a
broader device-integration tool with clipboard sharing, files, notifications,
remote input, media controls, and commands. [KDE feature overview](https://kdeconnect.kde.org/)

## Connections, trust, and delivery

KDE Connect discovers peers on the local network, then establishes direct device
connections. Its architecture separates discovery/link providers, devices,
packets, and feature plugins. LAN discovery includes UDP broadcasts; devices can
also be added by IP. Pairing requires accepting a request on the other device.
The LAN backend uses TLS and checks a paired device’s stored certificate. This
is encrypted peer communication, with no central KDE message service in the
examined path. [Architecture](https://github.com/KDE/kdeconnect-kde/blob/master/README.md),
[LAN implementation](https://github.com/KDE/kdeconnect-kde/blob/master/core/backends/lan/lanlinkprovider.cpp),
[pairing guide](https://userbase.kde.org/KDEConnect#Pairing_two_devices_together)

“Same Wi-Fi only” would overstate the restriction. KDE documents OpenVPN use
across networks: bridged VPNs support broadcast discovery, while routed VPNs can
use manually entered IP addresses. A local connection needs no internet or hosted infrastructure.
These options still require a reachable peer; they do not create a cloud mailbox.
[VPN documentation](https://userbase.kde.org/KDEConnect#Running_KDE_Connect_over_OpenVPN)

The desktop `sendPacket` implementation tries available links and returns failure
when none can send. The clipboard plugin can exchange the current clipboard on
reconnection; that is different from retaining every intervening message. No
durable offline text inbox is documented in the sources examined.
[Device send implementation](https://github.com/KDE/kdeconnect-kde/blob/master/core/device.cpp),
[clipboard implementation](https://github.com/KDE/kdeconnect-kde/blob/master/plugins/clipboard/clipboardplugin.cpp)

PowerBin instead writes encrypted text to local SQLite, queues uploads, and uses
Postgres plus PowerSync to reach another device later. Transfers expire one hour
after creation; queued transfers arriving after expiry are not delivered. The
current controller sends to one selected device or, by default, all other trusted
devices. Saved snippets persist and remain readable locally while disconnected.
Hosting requires the API, PowerSync, and two Postgres services.
[Controller](../app/src/controller.rs), [sync integration](../app/src/db_native.rs),
[deployment setup](../railway/README.md)

## Text, browser access, and extension

KDE Connect supports text clipboard synchronization, plain-text sharing, and URL
sharing. Clipboard changes can propagate automatically when enabled; Android 10+
restricts background clipboard reads, so KDE documents explicit Send Clipboard
actions and workarounds. This is convenient for connected devices, whereas
PowerBin currently asks the user to send and copy text explicitly.
[Clipboard and sharing guide](https://userbase.kde.org/KDEConnect),
[PowerBin UI](../app/ui/workspace.tsx)

KDE’s browser integration is a browser extension plus desktop integration for
sending links and controlling web media. It is not documented as a standalone
browser client or an installation-free guest receiver. KDE’s published feature
and plugin documentation does not describe a persistent, synchronized snippet
library, expiring guest links, or atomic reveal-and-burn. These are findings about
the documented product, not proof that custom plugins cannot implement them.
[Browser integration](https://kdeconnect.kde.org/),
[plugin architecture](https://github.com/KDE/kdeconnect-kde/blob/master/README.md)

PowerBin supplies a paired browser app, Saved tab, and one-use guest links whose
decryption key is in the URL fragment. Guest creation and reveal need the live
server; the local upload queue does not make guest links work offline. The
protocol is unaudited, burning cannot retract existing copies, and browser clients
trust code served by their origin. [Privacy and guest behavior](../README.md#privacy-and-burning),
[controller](../app/src/controller.rs)

KDE Connect’s plugins and configurable shell commands make it substantially more
extensible for device automation. Current downloads include Linux, Android,
Windows, stable macOS, and iOS. Prefer the download page over the desktop README’s
outdated Windows/macOS installation paragraph. iOS explicitly cannot operate as
an always-running background daemon or mirror other apps’ notifications; feature
parity should not be assumed across platforms.
[Downloads](https://kdeconnect.kde.org/download.html),
[commands](https://kdeconnect.kde.org/),
[iOS limitations](https://github.com/KDE/kdeconnect-ios/blob/master/README.md)
