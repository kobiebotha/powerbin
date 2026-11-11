import { cleanup, mount, Scroll, signal, Text, View, windowSize } from "nsh";
import { Button } from "nsh/base";
import { PowerBin, type UiState } from "relay/native";
import { color, focus, mono, Panel, setField, small, type State } from "./ui/components";
import { Guest } from "./ui/guest";
import { Setup } from "./ui/pairing";
import { Workspace } from "./ui/workspace";

/** One root subscription observes the engine-owned core across screen changes. */
function App() {
  const snapshot = signal<UiState | undefined>(undefined);
  const stop = PowerBin.onChange((state) => snapshot.set(state));
  cleanup(stop);
  const state: State = () => snapshot()!;
  return <View class="font-mono text-[#d0edcf]" style={{
    flex: 1, backgroundColor: color.bg,
    backgroundImage: "radial-gradient(ellipse at 50% 0%, #102b1799 0%, #050a0700 75%)",
    paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)",
  }}>
    <Scroll style={{ flex: 1 }}>
      <View style={{
        width: "100%", maxWidth: 860, marginHorizontal: "auto", padding: windowSize().width >= 700 ? 40 : 20, gap: 30,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 22, borderBottomWidth: 1, borderColor: color.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View style={{ width: 36, height: 36, borderRadius: 2, borderWidth: 1, borderColor: color.line, backgroundColor: color.accentSoft, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ ...mono, fontSize: 17, color: color.accent }}>{">_"}</Text>
            </View>
            <View style={{ gap: 5 }}>
              <Text style={{ ...mono, fontSize: 20, fontWeight: "600", letterSpacing: 2, color: color.accent, textShadow: "0 0 12px #9bff9a33" }}>POWERBIN</Text>
              <Text style={{ ...small, fontSize: 9, letterSpacing: 1.4 }}>PRIVATE TEXT RELAY</Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 5, height: 5, backgroundColor: !snapshot() || snapshot()!.busy ? color.warning : color.accent }} />
            <Text style={{ ...small, fontSize: 10, maxWidth: windowSize().width < 400 ? 90 : 160 }}>
              {!snapshot() || snapshot()!.busy ? "Working…" : snapshot()!.status}
            </Text>
          </View>
        </View>
        <If when={snapshot()?.ready} else={<Panel><Text style={{ ...mono, fontSize: 13, color: color.accent }}>Opening your device…</Text></Panel>}>
          <If when={state().guest} else={
            <If when={state().session} else={<Setup state={state} />}><Workspace state={state} /></If>
          }><Guest state={state} /></If>
          <If when={state().error.length > 0}>
            <Panel style={{ borderColor: color.error }}>
              <Text style={{ ...mono, fontSize: 13, color: color.error }}>{state().error}</Text>
              <Button onPress={() => setField("error", "")} style={{ minHeight: 40, justifyContent: "center" }} focusStyle={focus}>
                <Text style={{ ...small, color: color.error }}>Dismiss</Text>
              </Button>
            </Panel>
          </If>
        </If>
      </View>
    </Scroll>
    <View style={{
      position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
      pointerEvents: "none",
      backgroundImage: "repeating-linear-gradient(0deg, #00000000 0px, #00000000 3px, #00000012 3px, #00000012 4px)",
    }} />
  </View>;
}

mount(App);
