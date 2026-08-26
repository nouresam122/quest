/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { onceReady } from "@webpack";
import {
    ApplicationStreamingStore,
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    QuestStore,
    RestAPI,
    RunningGameStore,
    UserStore,
} from "@webpack/common";

const settings = definePluginSettings({
    autoAcceptQuests: {
        type: OptionType.BOOLEAN,
        description: "Automatically accept all available quests",
        default: false,
        restartNeeded: false
    },
    logProgress: {
        type: OptionType.BOOLEAN,
        description: "Log quest completion progress to console",
        default: true,
        restartNeeded: false
    },
    achievementBypass: {
        type: OptionType.BOOLEAN,
        description: "Attempt OAuth/DiscordSays bypass for ACHIEVEMENT_IN_ACTIVITY quests",
        default: true,
        restartNeeded: false
    }
});

const SUPPORTED_TASKS = [
    "ACHIEVEMENT_IN_ACTIVITY",
    "WATCH_VIDEO",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY",
    "WATCH_VIDEO_ON_MOBILE"
];

let isApp: boolean;
let questQueue: any[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let fluxUnsubs: (() => void)[] = [];
let sessionStarting = false;
let videoStaggerIndex = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function log(...args: any[]) {
    if (settings.store.logProgress) {
        console.log("[QuestAutoCompleterV2]", ...args);
    }
}

function getTaskConfig(quest: any) {
    return quest.config.taskConfig ?? quest.config.taskConfigV2;
}

function isCompletable(quest: any): boolean {
    if (new Date(quest.config.expiresAt).getTime() <= Date.now()) return false;
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return false;
    return SUPPORTED_TASKS.some(t => tasks[t] != null);
}

function isEnrolled(quest: any): boolean {
    return !!quest.userStatus?.enrolledAt;
}

function isCompleted(quest: any): boolean {
    return !!quest.userStatus?.completedAt;
}

function storesReady(): boolean {
    if (!QuestStore) { log("QuestStore not ready yet"); return false; }
    if (!FluxDispatcher) { log("FluxDispatcher not ready yet"); return false; }
    if (!RestAPI) { log("RestAPI not ready yet"); return false; }
    return true;
}

async function enrollQuest(quest: any): Promise<boolean> {
    const name = quest.config.messages?.questName ?? quest.id;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await RestAPI.post({
                url: `/quests/${quest.id}/enroll`,
                body: {
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null,
                    metadata_sealed: null,
                    traffic_metadata_raw: null
                }
            });

            if (res?.status === 429) {
                const waitMs = ((res.body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Auto-accepted: ${name}`);
            return true;

        } catch (e: any) {
            const status: number = e?.status ?? e?.res?.status ?? 0;
            const body: any = e?.body ?? e?.res?.body ?? {};

            if (status === 429) {
                const waitMs = ((body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Failed to accept "${name}" (status ${status}):`, body?.message ?? e);
            return false;
        }
    }

    log(`Gave up enrolling "${name}" after ${MAX_RETRIES} rate-limited attempts`);
    return false;
}

async function autoAcceptAvailableQuests(): Promise<boolean> {
    if (!settings.store.autoAcceptQuests) return false;
    if (!QuestStore?.quests) return false;

    const unaccepted = [...QuestStore.quests.values()].filter((q: any) =>
        !isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    if (unaccepted.length === 0) return false;

    log(`Auto-accepting ${unaccepted.length} quest(s)...`);
    let enrolledAny = false;

    for (const q of unaccepted) {
        const ok = await enrollQuest(q);
        if (ok) {
            enrolledAny = true;
            if (!q.userStatus) q.userStatus = {};
            if (!q.userStatus.enrolledAt) q.userStatus.enrolledAt = new Date().toISOString();
            launchQuest(q);
        }
        await sleep(3000);
    }

    return enrolledAny;
}

const activeQuestIds = new Set<string>();

function launchQuest(quest: any) {
    if (activeQuestIds.has(quest.id)) return;
    if (isCompleted(quest) || !isCompletable(quest)) return;
    activeQuestIds.add(quest.id);
    log(`Launching: ${quest.config.messages?.questName ?? quest.id}`);
    doJob(quest);
}

function launchEligibleQuests() {
    if (!QuestStore?.quests) return;
    const enrolled = [...QuestStore.quests.values()].filter((q: any) =>
        isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );
    for (const quest of enrolled) launchQuest(quest);
}

async function scan() {
    if (!storesReady()) return;
    await autoAcceptAvailableQuests();
    launchEligibleQuests();
}

function startSession() {
    if (sessionStarting) return;
    sessionStarting = true;

    questQueue = [];
    activeQuestIds.clear();
    videoStaggerIndex = 0;

    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
    }

    onceReady.then(async () => {
        sessionStarting = false;

        if (!storesReady()) {
            console.error("[QuestAutoCompleterV2] Stores unexpectedly missing after onceReady – aborting session");
            return;
        }

        isApp = typeof (window as any).DiscordNative !== "undefined";
        log("Stores ready, isApp =", isApp);

        try {
            log("Fetching quests from API...");
            await RestAPI.get({ url: "/quests/@me" });
            log("Quest data loaded");
        } catch (e) {
            log("Could not pre-fetch quests (will retry on next poll):", e);
        }

        pollInterval = setInterval(() => scan(), 60_000);
        scan();
    });
}

async function safePost(url: string, body: any, label: string): Promise<any> {
    while (true) {
        try {
            const res = await RestAPI.post({ url, body });
            if (res?.status === 429) {
                const wait = ((res.body?.retry_after ?? 5) + 0.5) * 1000;
                log(`[${label}] rate limited, retrying in ${Math.ceil(wait / 1000)}s...`);
                await sleep(wait);
                continue;
            }
            return res;
        } catch (e: any) {
            const status = e?.status ?? e?.res?.status ?? 0;
            const body2 = e?.body ?? e?.res?.body ?? {};
            if (status === 429) {
                const wait = ((body2?.retry_after ?? 5) + 0.5) * 1000;
                log(`[${label}] rate limited, retrying in ${Math.ceil(wait / 1000)}s...`);
                await sleep(wait);
                continue;
            }
            throw e;
        }
    }
}

// ── Stream key helper for heartbeat spoofing ──────────────────────────────────
function getStreamKey(): string | null {
    try {
        const ownerId = UserStore?.getCurrentUser?.()?.id;
        const dmChan = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id;
        if (dmChan) return `call:${dmChan}:${ownerId ?? "1"}`;

        const guilds = GuildChannelStore?.getAllGuilds?.() ?? {};
        for (const g of Object.values<any>(guilds)) {
            const voiceChan = g?.VOCAL?.[0]?.channel;
            if (voiceChan?.id) {
                const guildId = voiceChan.guild_id ?? g?.id;
                if (guildId) return `guild:${guildId}:${voiceChan.id}:${ownerId ?? "1"}`;
            }
        }
        return dmChan ? `call:${dmChan}:1` : null;
    } catch (e) {
        return null;
    }
}

// ── Multi-transport bypass POST (CSP-safe) ────────────────────────────────────
let relayProbe: Promise<boolean> | null = null;
let relayProbeAt = 0;
const RELAY_URL = "http://127.0.0.1:43210";

async function probeRelay(): Promise<boolean> {
    if (relayProbe && Date.now() - relayProbeAt < 60000) return relayProbe;
    relayProbeAt = Date.now();
    return relayProbe = (async () => {
        try {
            const r = await Promise.race([
                fetch(`${RELAY_URL}/health`, { method: "GET", redirect: "error" }),
                new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 800))
            ]);
            return r.ok;
        } catch {
            return false;
        }
    })();
}

async function bypassPost(
    url: string,
    headers: Record<string, string>,
    jsonBody: string
): Promise<{ ok: boolean; status: number; body: string }> {
    // 1) Localhost relay if available (tools/orion-relay)
    const hasRelay = await probeRelay();
    if (hasRelay) {
        try {
            const r = await fetch(`${RELAY_URL}/proxy`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, headers, body: jsonBody }),
                redirect: "error"
            });
            if (r.ok) {
                const res = await r.json();
                if (res.ok) return { ok: true, status: res.status, body: res.body };
            }
        } catch (e) {
            relayProbe = null;
            log("[Bypass] Relay error, trying fallback transports:", e);
        }
    }

    // 2) VencordNative IPC helper (if native.ts is loaded in Vencord)
    try {
        const helper = (window as any).VencordNative?.pluginHelpers?.QuestAutoCompleterV2
            ?? (window as any).VencordNative?.pluginHelpers?.OrionQuests;
        if (helper) {
            const u = new URL(url);
            const appId = u.hostname.split(".")[0];
            const questId = headers["X-Discord-Quest-ID"];
            const referrer = headers["Referer"];
            if (u.pathname.endsWith("/acf/authorize")) {
                const { code } = JSON.parse(jsonBody);
                const r = await helper.discordsaysAuthorize({ appId, questId, authCode: code, referrer });
                if (r.ok) return { ok: true, status: r.status, body: r.body };
            } else if (u.pathname.endsWith("/acf/quest/progress")) {
                const { progress } = JSON.parse(jsonBody);
                const token = headers["X-Auth-Token"];
                const r = await helper.discordsaysProgress({ appId, questId, token, target: progress, referrer });
                if (r.ok) return { ok: true, status: r.status, body: r.body };
            }
        }
    } catch (e) {
        log("[Bypass] VencordNative path error:", e);
    }

    // 3) DiscordNative HTTP probe
    const dn = (window as any).DiscordNative;
    if (dn) {
        const probes = [
            () => dn.http?.makeRequest,
            () => dn.app?.makeRequest,
        ];
        for (const probe of probes) {
            try {
                const fn = probe();
                if (typeof fn === "function") {
                    const r = await fn.call(dn, { method: "POST", url, headers, body: jsonBody });
                    if (r && (r.status || r.statusCode)) {
                        const status = r.status ?? r.statusCode;
                        return { ok: status >= 200 && status < 300, status, body: r.body ?? r.responseText ?? "" };
                    }
                }
            } catch {}
        }
    }

    // 4) Direct fetch (browser / web discord / unrestricted)
    const res = await fetch(url, { method: "POST", headers, body: jsonBody, redirect: "error" });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
}

// ── OAuth2 / Discord Says bypass for ACHIEVEMENT_IN_ACTIVITY ─────────────────
async function bypassAchievement(quest: any, target: number, appId: string, questName: string): Promise<boolean> {
    if (!settings.store.achievementBypass) {
        log(`[Bypass] Achievement bypass disabled in settings for "${questName}"`);
        return false;
    }
    if (!appId || !/^\d+$/.test(String(appId))) {
        log(`[Bypass] Invalid or non-numeric appId "${appId}" for "${questName}"`);
        return false;
    }

    let preGrantIds: Set<string> | undefined;
    try {
        const before = await RestAPI.get({ url: "/oauth2/tokens" });
        preGrantIds = new Set(
            (before?.body || [])
                .filter((tk: any) => String(tk.application?.id) === String(appId))
                .map((tk: any) => String(tk.id))
        );
    } catch (e) {
        log(`[Bypass] Could not snapshot existing OAuth tokens for "${questName}":`, e);
    }

    try {
        log(`[Bypass] Requesting OAuth authorization for "${questName}" (App: ${appId})...`);
        const authRes = await RestAPI.post({
            url: "/oauth2/authorize",
            query: {
                response_type: "code",
                client_id: String(appId),
                scope: "identify applications.commands applications.entitlements"
            },
            body: {
                permissions: "0",
                authorize: true,
                integration_type: 1,
                location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
            }
        });

        const location: string | undefined = authRes?.body?.location;
        if (!location) throw new Error("No location in /oauth2/authorize response");
        const authCode = new URL(location).searchParams.get("code");
        if (!authCode) throw new Error("No code parameter in authorize redirect");

        const ticketRes = await RestAPI.post({
            url: `/applications/${appId}/proxy-tickets`,
            body: {}
        });
        const proxyTicket = ticketRes?.body?.ticket;
        if (!proxyTicket) throw new Error("No proxy ticket received");

        const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

        const dsAuthRes = await bypassPost(
            `https://${appId}.discordsays.com/.proxy/acf/authorize`,
            {
                "Content-Type": "application/json",
                "X-Auth-Token": "",
                "X-Discord-Quest-ID": quest.id,
                "Referer": referrer
            },
            JSON.stringify({ code: authCode })
        );

        if (!dsAuthRes.ok) throw new Error(`Discord Says authorize returned HTTP ${dsAuthRes.status}`);

        let dsToken: string | undefined;
        try {
            dsToken = JSON.parse(dsAuthRes.body)?.token;
        } catch {
            throw new Error("Discord Says authorize returned non-JSON body: " + String(dsAuthRes.body).slice(0, 100));
        }

        if (!dsToken) throw new Error("No token in Discord Says authorize response");

        const progRes = await bypassPost(
            `https://${appId}.discordsays.com/.proxy/acf/quest/progress`,
            {
                "Content-Type": "application/json",
                "X-Auth-Token": dsToken,
                "X-Discord-Quest-ID": quest.id,
                "Referer": referrer
            },
            JSON.stringify({ progress: target })
        );

        if (!progRes.ok) throw new Error(`Discord Says progress returned HTTP ${progRes.status}`);

        log(`[Bypass] Successfully completed "${questName}" via Discord Says bypass!`);
        return true;
    } catch (e: any) {
        const code = e?.body?.code ?? e?.res?.body?.code;
        if (code === 50165) {
            log(`[Bypass] "${questName}" is age-gated or delisted. Discord blocks the proxy ticket.`);
        } else {
            log(`[Bypass] Failed bypass for "${questName}":`, e?.message ?? e);
        }
        return false;
    } finally {
        if (preGrantIds) {
            try {
                const after = await RestAPI.get({ url: "/oauth2/tokens" });
                const ours = (after?.body || []).filter((tk: any) =>
                    String(tk.application?.id) === String(appId) && !preGrantIds.has(String(tk.id))
                );
                for (const g of ours) {
                    if (typeof RestAPI.del === "function") {
                        await RestAPI.del({ url: `/oauth2/tokens/${g.id}` });
                    } else if (typeof (RestAPI as any).delete === "function") {
                        await (RestAPI as any).delete({ url: `/oauth2/tokens/${g.id}` });
                    }
                }
            } catch (err) {
                log("[Bypass] Cleanup error (non-fatal):", err);
            }
        }
    }
}

function doJob(quest: any) {
    try {
        const taskConfig = getTaskConfig(quest);
        const questName  = quest.config.messages?.questName ?? quest.id;

        if (!taskConfig?.tasks) {
            console.error("[QuestAutoCompleterV2] No taskConfig.tasks for:", questName);
            activeQuestIds.delete(quest.id);
            return;
        }

        const taskName = SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null);
        if (!taskName) {
            console.error("[QuestAutoCompleterV2] No supported task for:", questName,
                "available keys:", Object.keys(taskConfig.tasks));
            activeQuestIds.delete(quest.id);
            return;
        }

        const taskData      = taskConfig.tasks[taskName];
        const secondsNeeded = taskData.target;
        let secondsDone     = quest.userStatus?.progress?.[taskName]?.value ?? 0;
        const pid           = Math.floor(Math.random() * 30000) + 1000;

        // ── FIX: new Discord format stores applicationId inside applications[]
        // taskData = { type, target, applications: [ { id, name, ... } ] }
        const rawAppId =
            quest.config.application?.id ??
            taskData.applicationId ??
            taskData.application_id ??
            taskData.applications?.[0]?.id ??
            taskData.applications?.[0];

        const applicationId = typeof rawAppId === "object" ? rawAppId?.id : rawAppId;

        const applicationName =
            quest.config.application?.name ??
            taskData.applicationName ??
            taskData.applications?.[0]?.name ??
            questName;

        log(`doJob: "${questName}" task=${taskName} need=${secondsNeeded}s done=${secondsDone}s appId=${applicationId}`);

        // ── ACHIEVEMENT_IN_ACTIVITY ──────────────────────────────────────────
        if (taskName === "ACHIEVEMENT_IN_ACTIVITY") {
            const target = taskData.target ?? 1;
            let current = quest.userStatus?.progress?.[taskName]?.value ?? 0;

            (async () => {
                try {
                    log(`[ACHIEVEMENT] Starting "${questName}" (target: ${target}, done: ${current})...`);

                    // 1. Attempt heartbeat spoofing first
                    const streamKey = getStreamKey();
                    let heartbeatSuccess = false;

                    if (streamKey) {
                        log(`[ACHIEVEMENT] Attempting heartbeat spoofing for "${questName}"...`);
                        const beat = {
                            stream_key: streamKey,
                            application_id: String(applicationId || ""),
                            terminal: false
                        };

                        let failCount = 0;
                        while (current < target) {
                            try {
                                const res = await safePost(
                                    `/quests/${quest.id}/heartbeat`,
                                    beat,
                                    questName
                                );
                                current = res?.body?.progress?.[taskName]?.value ??
                                          res?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ??
                                          current;

                                log(`[${questName}] Achievement progress: ${current}/${target}`);
                                failCount = 0;

                                if (current >= target) {
                                    heartbeatSuccess = true;
                                    try {
                                        await safePost(
                                            `/quests/${quest.id}/heartbeat`,
                                            { ...beat, terminal: true },
                                            questName
                                        );
                                    } catch {}
                                    break;
                                }
                            } catch (e: any) {
                                failCount++;
                                const status = e?.status ?? e?.res?.status;
                                if (status && [400, 403, 404, 409, 410].includes(status)) {
                                    log(`[ACHIEVEMENT] Heartbeat rejected (HTTP ${status}) for "${questName}". Falling back to OAuth bypass.`);
                                    break;
                                }
                                if (failCount >= 3) {
                                    log(`[ACHIEVEMENT] Heartbeat failed ${failCount} times for "${questName}". Falling back to OAuth bypass.`);
                                    break;
                                }
                            }
                            await sleep(20000);
                        }

                        if (current >= target) {
                            heartbeatSuccess = true;
                        }
                    }

                    // 2. If heartbeat didn't complete it, try Discord Says OAuth bypass
                    if (!heartbeatSuccess && current < target) {
                        log(`[ACHIEVEMENT] Attempting Discord Says OAuth bypass for "${questName}"...`);
                        const bypassed = await bypassAchievement(quest, target, String(applicationId || ""), questName);
                        if (bypassed) {
                            current = target;
                        }
                    }

                    if (current >= target) {
                        log(`Completed: ${questName}`);
                    } else {
                        log(`Could not complete achievement quest "${questName}" (heartbeat rejected & bypass failed or blocked by age-gate/CSP).`);
                    }
                } catch (e) {
                    log(`Error completing "${questName}":`, e);
                } finally {
                    activeQuestIds.delete(quest.id);
                }
            })();

        // ── WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE ───────────────────────────────
        } else if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
            const speed     = 7;
            const maxFuture = 10;
            const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
            let completed = false;
            const myStagger = videoStaggerIndex++ * 3000;

            (async () => {
                try {
                    if (myStagger > 0) await sleep(myStagger);

                    while (true) {
                        const elapsed    = Math.floor((Date.now() - enrolledAt) / 1000);
                        const maxAllowed = elapsed + maxFuture;
                        const diff       = maxAllowed - secondsDone;
                        const timestamp  = secondsDone + speed;

                        if (diff >= speed) {
                            const res = await safePost(
                                `/quests/${quest.id}/video-progress`,
                                { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) },
                                questName
                            );
                            completed   = res.body?.completed_at != null;
                            secondsDone = Math.min(secondsNeeded, timestamp);
                            log(`[${questName}] Video: ${Math.round(secondsDone)}/${secondsNeeded}s`);
                        }

                        if (secondsDone >= secondsNeeded) break;
                        await sleep(3000);
                    }

                    if (!completed) {
                        await safePost(
                            `/quests/${quest.id}/video-progress`,
                            { timestamp: secondsNeeded },
                            questName
                        );
                    }

                    log(`Completed: ${questName}`);
                } catch (e) {
                    log(`Error completing "${questName}":`, e);
                }
                activeQuestIds.delete(quest.id);
            })();

            log(`Spoofing video: ${questName} (stagger ${myStagger / 1000}s)`);

        // ── PLAY_ON_DESKTOP ───────────────────────────────────────────────────
        } else if (taskName === "PLAY_ON_DESKTOP") {
            if (!isApp) {
                log(`${questName} requires the desktop app – skipping`);
                activeQuestIds.delete(quest.id);
                return;
            }

            if (!applicationId) {
                console.error("[QuestAutoCompleterV2] Cannot find applicationId for:", questName, "\ntaskData:", taskData);
                activeQuestIds.delete(quest.id);
                return;
            }

            RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` })
                .then((res: any) => {
                    const appData = res.body?.[0];

                    if (!appData) {
                        log(`No app data returned for "${questName}" – skipping`);
                        activeQuestIds.delete(quest.id);
                        return;
                    }

                    const win32Exe = appData.executables?.find((x: any) => x.os === "win32");
                    const anyExe   = appData.executables?.[0];
                    const exeName  = (win32Exe ?? anyExe)?.name?.replace(">", "") ?? `${appData.name}.exe`;

                    const fakeGame = {
                        cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                        exeName,
                        exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                        hidden: false,
                        isLauncher: false,
                        id: applicationId,
                        name: appData.name,
                        pid,
                        pidPath: [pid],
                        processName: appData.name,
                        start: Date.now(),
                    };

                    const realGames           = RunningGameStore.getRunningGames();
                    const realGetRunningGames = RunningGameStore.getRunningGames;
                    const realGetGameForPID   = RunningGameStore.getGameForPID;

                    const cleanup = () => {
                        RunningGameStore.getRunningGames = realGetRunningGames;
                        RunningGameStore.getGameForPID   = realGetGameForPID;
                        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                    };

                    RunningGameStore.getRunningGames = () => [fakeGame];
                    RunningGameStore.getGameForPID   = (p: number) => (p === fakeGame.pid ? fakeGame : undefined);
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });

                    const fn = (data: any) => {
                        try {
                            const progress = quest.config.configVersion === 1
                                ? data.userStatus.streamProgressSeconds
                                : Math.floor(data.userStatus.progress?.PLAY_ON_DESKTOP?.value ?? 0);

                            log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                            if (progress >= secondsNeeded) {
                                log(`Completed: ${questName}`);
                                cleanup();
                                activeQuestIds.delete(quest.id);
                            }
                        } catch (e) {
                            log(`Error in heartbeat handler for "${questName}":`, e);
                            cleanup();
                            activeQuestIds.delete(quest.id);
                        }
                    };

                    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                    log(`Spoofed game: ${appData.name} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left`);
                })
                .catch((e: any) => {
                    log(`Failed to fetch app data for "${questName}":`, e);
                    activeQuestIds.delete(quest.id);
                });

        // ── STREAM_ON_DESKTOP ─────────────────────────────────────────────────
        } else if (taskName === "STREAM_ON_DESKTOP") {
            if (!isApp) {
                log(`${questName} requires the desktop app – skipping`);
                activeQuestIds.delete(quest.id);
                return;
            }

            const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;

            const cleanup = () => {
                ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
                FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
            };

            ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
                id: applicationId,
                pid,
                sourceName: null
            });

            const fn = (data: any) => {
                try {
                    const progress = quest.config.configVersion === 1
                        ? data.userStatus.streamProgressSeconds
                        : Math.floor(data.userStatus.progress?.STREAM_ON_DESKTOP?.value ?? 0);

                    log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                    if (progress >= secondsNeeded) {
                        log(`Completed: ${questName}`);
                        cleanup();
                        activeQuestIds.delete(quest.id);
                    }
                } catch (e) {
                    log(`Error in heartbeat handler for "${questName}":`, e);
                    cleanup();
                    activeQuestIds.delete(quest.id);
                }
            };

            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
            log(`Spoofed stream: ${applicationName} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left (need 1+ in VC)`);

        // ── PLAY_ACTIVITY ─────────────────────────────────────────────────────
        } else if (taskName === "PLAY_ACTIVITY") {
            const channelId =
                ChannelStore.getSortedPrivateChannels()[0]?.id ??
                (Object.values(GuildChannelStore.getAllGuilds()) as any[])
                    .find((x: any) => x?.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;

            if (!channelId) {
                log("No suitable channel found for PLAY_ACTIVITY – skipping");
                activeQuestIds.delete(quest.id);
                return;
            }

            const streamKey = `call:${channelId}:1`;

            (async () => {
                try {
                    log(`Activity: ${questName}`);
                    while (true) {
                        const res = await safePost(
                            `/quests/${quest.id}/heartbeat`,
                            { stream_key: streamKey, terminal: false },
                            questName
                        );
                        const progress = res.body.progress?.PLAY_ACTIVITY?.value ?? 0;
                        log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                        if (progress >= secondsNeeded) {
                            await safePost(
                                `/quests/${quest.id}/heartbeat`,
                                { stream_key: streamKey, terminal: true },
                                questName
                            );
                            break;
                        }

                        await sleep(20000);
                    }
                    log(`Completed: ${questName}`);
                } catch (e) {
                    log(`Error completing "${questName}":`, e);
                }
                activeQuestIds.delete(quest.id);
            })();
        }

    } catch (outerErr: any) {
        console.error("[QuestAutoCompleterV2] doJob crashed:", outerErr);
        activeQuestIds.delete(quest?.id);
    }
}

export default definePlugin({
    name: "QuestAutoCompleterV2",
    description: "Automatically completes Discord quests. Supports auto-accept, game/stream/video spoofing, and achievement activity bypass.",
    authors: [{ name: "Seramicx", id: 543577333530099742n }],
    settings,

    start() {
        log("Starting...");

        try {
            if (FluxDispatcher) {
                const onConnectionOpen = () => {
                    log("CONNECTION_OPEN – starting new session...");
                    startSession();
                };

                const onStatusUpdate = () => {
                    log("QUEST_USER_STATUS_UPDATE – checking quests...");
                    setTimeout(() => launchEligibleQuests(), 500);
                };

                FluxDispatcher.subscribe?.("CONNECTION_OPEN", onConnectionOpen);
                FluxDispatcher.subscribe?.("QUEST_USER_STATUS_UPDATE", onStatusUpdate);

                fluxUnsubs = [
                    () => FluxDispatcher.unsubscribe?.("CONNECTION_OPEN", onConnectionOpen),
                    () => FluxDispatcher.unsubscribe?.("QUEST_USER_STATUS_UPDATE", onStatusUpdate),
                ];
            } else {
                log("FluxDispatcher not ready yet during early start, session will start automatically.");
            }

            startSession();
        } catch (e) {
            console.error("[QuestAutoCompleterV2] Error starting plugin:", e);
        }
    },

    stop() {
        log("Stopping...");

        try {
            for (const unsub of fluxUnsubs) {
                if (typeof unsub === "function") unsub();
            }
        } catch (e) {
            console.error("[QuestAutoCompleterV2] Error stopping flux subscriptions:", e);
        }
        fluxUnsubs = [];

        if (pollInterval !== null) {
            clearInterval(pollInterval);
            pollInterval = null;
        }

        questQueue = [];
        activeQuestIds.clear();
        videoStaggerIndex = 0;
        sessionStarting = false;
    }
});
