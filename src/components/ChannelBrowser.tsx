import { DialogButton } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";

interface ChannelMember { id: string; avatar: string | null; }
interface VoiceChannel { id: string; name: string; members: ChannelMember[]; }
interface Guild { id: string; name: string; icon: string | null; channels: VoiceChannel[]; }

const Btn = DialogButton as any;

function MemberAvatars({ members }: { members: ChannelMember[] }) {
  if (!members || members.length === 0) return null;
  const shown = members.slice(0, 4);
  const extra = members.length - shown.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {shown.map(m => (
        <img
          key={m.id}
          src={m.avatar
            ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.webp?size=16`
            : `https://cdn.discordapp.com/embed/avatars/0.png`}
          width={16} height={16}
          style={{ borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }}
        />
      ))}
      {extra > 0 && <span style={{ fontSize: 9, opacity: 0.5 }}>+{extra}</span>}
      <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{members.length}</span>
    </div>
  );
}

export function ChannelBrowser() {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    call<[], any>("get_guilds_vc").then(res => {
      if (Array.isArray(res)) setGuilds(res);
      else setError(t("error") + JSON.stringify(res));
    }).catch(e => setError(String(e)));
  };

  useEffect(() => { refresh(); }, []);

  const join = async (channelId: string, guildId: string) => {
    setJoining(channelId);
    await call("join_vc", channelId, guildId);
    setTimeout(() => setJoining(null), 2000);
  };

  if (error)
    return <div style={{ padding: 8, color: "#ff6b6b", fontSize: 12 }}>{error}</div>;

  if (guilds.length === 0)
    return <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_servers")}</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
        <Btn onClick={refresh} style={{ padding: "2px 8px", fontSize: 10, minHeight: 0 }}>↻</Btn>
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {guilds.map(guild => {
          const totalActive = guild.channels.reduce((n, c) => n + (c.members?.length ?? 0), 0);
          return (
            <div key={guild.id} style={{ marginBottom: 3 }}>
              <Btn
                onClick={() => setExpanded(expanded === guild.id ? null : guild.id)}
                style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "5px 8px" }}
              >
                {guild.icon
                  ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=32`}
                      width={18} height={18} style={{ borderRadius: "50%", flexShrink: 0 }} />
                  : <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#5865f2", flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff" }}>
                      {guild.name[0]}
                    </div>
                }
                <span style={{ flex: 1, textAlign: "left", fontSize: 12 }}>{guild.name}</span>
                {totalActive > 0 && <span style={{ fontSize: 9, color: "#23a55a" }}>● {totalActive}</span>}
                <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded === guild.id ? "▲" : "▼"}</span>
              </Btn>

              {expanded === guild.id && (
                <div style={{ paddingLeft: 6, marginTop: 2 }}>
                  {guild.channels.map(ch => (
                    <Btn
                      key={ch.id}
                      onClick={() => join(ch.id, guild.id)}
                      style={{
                        width: "100%", padding: "4px 8px", marginBottom: 2, fontSize: 11,
                        background: joining === ch.id ? "#5865f2" : undefined,
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                    >
                      <span style={{ opacity: 0.6, fontSize: 10 }}>🔊</span>
                      <span style={{ flex: 1, textAlign: "left" }}>{joining === ch.id ? t("connecting") : ch.name}</span>
                      <MemberAvatars members={ch.members} />
                    </Btn>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
