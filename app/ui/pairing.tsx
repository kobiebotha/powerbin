import { effect, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Action, color, dispatch, Field, fingerprint, focus, Heading, mono, Panel, row, setField, small, type State } from "./components";

export function Pairing(props: { state: State }) {
  return <If when={props.state().pairing}>
    {(pairing) => <Panel style={{ borderColor: color.accent }}>
      <Text style={{ ...mono, fontSize: 18, fontWeight: "600", color: color.ink }}>Pair a device.</Text>
      <Text style={{ ...mono, fontSize: 28, color: color.accent }}>{pairing().code}</Text>
      <Text style={{ ...mono, fontSize: 13, color: color.muted }}>
        {pairing().peerName ? `Compare this entire fingerprint with ${pairing().peerName} before pairing.` : "Enter this code on a device you already trust."}
      </Text>
      <Text style={{ ...mono, fontSize: 13, color: color.accent }}>{fingerprint(pairing().fingerprint)}</Text>
      <If when={pairing().canConfirm}>
        <Action label="Fingerprints match · Pair" state={props.state} primary action="confirmPairing" />
      </If>
      <Button onPress={() => dispatch("cancelPairing")}
        style={{ minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: 2 }}
        activeStyle={{ opacity: 0.6 }} focusStyle={focus}>
        <Text style={{ ...mono, fontSize: 13, color: color.muted }}>Cancel pairing</Text>
      </Button>
    </Panel>}
  </If>;
}

export function Setup(props: { state: State }) {
  return <View style={{ gap: 26 }}>
    <Heading title="Your private relay."
      subtitle="Encrypted snippets across your paired devices." />
    <If when={!props.state().pairing}>
      <View style={{ gap: 20 }}>
        <Panel>
          <Field label="PowerBin server" placeholder="https://your-powerbin.example" field="origin" state={props.state} />
          <Field label="This device" placeholder="My MacBook" field="name" state={props.state} />
          <Action label="Pair this device" state={props.state} primary action="startPairing" />
          <Text style={small}>Already using PowerBin? Pair with a trusted device.</Text>
        </Panel>
        <Panel>
          <Text style={{ ...mono, fontSize: 16, fontWeight: "600", color: color.ink }}>First device?</Text>
          <Field label="Setup token" placeholder="Your installation’s setup token" field="bootstrapToken" state={props.state} masked />
          <View style={{ gap: 8 }}>
            <Text style={{ ...small, lineHeight: 19 }}>On Railway, open your project, select the powerbin service, then copy BOOTSTRAP_TOKEN from the Variables tab.</Text>
            <Text style={{ ...small, lineHeight: 19 }}>Running locally? Copy BOOTSTRAP_TOKEN from the project’s .env file, created by pnpm run setup.</Text>
          </View>
          <Action label="Create my PowerBin" state={props.state} action="bootstrap" />
        </Panel>
      </View>
    </If>
    <Pairing state={props.state} />
  </View>;
}

export function Devices(props: { state: State }) {
  const unpairing = signal("");
  const renaming = signal("");
  const originalName = signal("");
  effect(() => {
    const device = props.state().devices.find((entry) => entry.id === renaming());
    if (device && device.name !== originalName() && device.name === props.state().deviceName && !props.state().busy && !props.state().error) {
      renaming.set("");
    }
  });
  return <View style={{ gap: 18 }}>
    <Heading title="Trusted devices." subtitle="Only devices you pair can read your private snippets." />
    <Pairing state={props.state} />
    <Each of={props.state().devices} key={(device) => device.id}>
      {(device) => <Panel style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ ...mono, fontSize: 17, fontWeight: "600", color: color.ink, flexShrink: 1 }}>{device().name}</Text>
          <If when={unpairing() !== device().id && renaming() !== device().id}>
            <View style={row}>
              <Button
                accessibilityLabel={`Rename ${device().name}`}
                disabled={props.state().busy}
                onPress={() => {
                  unpairing.set("");
                  originalName.set(device().name);
                  setField("deviceName", device().name);
                  renaming.set(device().id);
                }}
                style={{ minHeight: 40, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 2, borderWidth: 1, borderColor: color.line, justifyContent: "center" }}
                hoverStyle={{ borderColor: color.accent }} focusStyle={focus} disabledStyle={{ opacity: 0.45 }}
              ><Text style={{ ...mono, fontSize: 12, color: color.ink }}>Rename</Text></Button>
              <If when={props.state().session?.deviceId !== device().id}>
                <Button
                  accessibilityLabel={`Unpair ${device().name}`}
                  disabled={props.state().busy}
                  onPress={() => { renaming.set(""); unpairing.set(device().id); }}
                  style={{ minHeight: 40, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 2, borderWidth: 1, borderColor: color.line, justifyContent: "center" }}
                  hoverStyle={{ borderColor: color.error }} focusStyle={focus} disabledStyle={{ opacity: 0.45 }}
                ><Text style={{ ...mono, fontSize: 12, color: color.error }}>Unpair</Text></Button>
              </If>
            </View>
          </If>
        </View>
        <Text style={{ ...mono, fontSize: 12, color: color.accent }}>
          {props.state().session?.deviceId === device().id ? "This device" : "Paired device"}
        </Text>
        <Text style={{ ...mono, fontSize: 11, color: color.muted }}>{`Public key · ${device().publicKey.slice(0, 24)}…`}</Text>
        <If when={renaming() === device().id}>
          <View style={{ paddingTop: 14, marginTop: 6, gap: 12, borderTopWidth: 1, borderColor: color.line }}>
            <Field label="Device name" placeholder="Name this device" field="deviceName" state={props.state} />
            <View style={row}>
              <Button
                disabled={props.state().busy}
                onPress={() => {
                  if (props.state().deviceName.trim() === device().name) renaming.set("");
                  else dispatch("renameDevice", device().id);
                }}
                style={{ minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: color.accent, borderRadius: 2, backgroundColor: color.accent, alignItems: "center", justifyContent: "center" }}
                focusStyle={focus} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.45 }}
              ><Text style={{ ...mono, fontSize: 12, fontWeight: "600", color: color.bg }}>Save name</Text></Button>
              <Button
                disabled={props.state().busy} onPress={() => renaming.set("")}
                style={{ minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: color.line, borderRadius: 2, justifyContent: "center" }}
                hoverStyle={{ borderColor: color.accent }} focusStyle={focus} disabledStyle={{ opacity: 0.45 }}
              ><Text style={{ ...mono, fontSize: 12, color: color.muted }}>Cancel</Text></Button>
            </View>
          </View>
        </If>
        <If when={unpairing() === device().id}>
          <View style={{ paddingTop: 14, marginTop: 6, gap: 12, borderTopWidth: 1, borderColor: color.line }}>
            <Text style={{ ...mono, fontSize: 13, color: color.ink }}>{`Unpair ${device().name}?`}</Text>
            <Text style={{ ...small, lineHeight: 19 }}>Stops future server access. Offline and copied data may remain on that device.</Text>
            <View style={row}>
              <Action label="Unpair device" state={props.state} destructive action="unpairDevice" id={device().id} />
              <Button
                disabled={props.state().busy} onPress={() => unpairing.set("")}
                style={{ minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: color.line, borderRadius: 2, justifyContent: "center" }}
                hoverStyle={{ borderColor: color.accent }} focusStyle={focus} disabledStyle={{ opacity: 0.45 }}
              ><Text style={{ ...mono, fontSize: 12, color: color.muted }}>Cancel</Text></Button>
            </View>
          </View>
        </If>
      </Panel>}
    </Each>
    <If when={!props.state().pairing}>
      <Panel>
        <Text style={{ ...mono, fontSize: 17, fontWeight: "600", color: color.ink }}>Add a device.</Text>
        <Text style={{ ...mono, fontSize: 13, color: color.muted }}>On the new device, choose Pair this device. Enter its code here.</Text>
        <Field label="Pairing code" placeholder="ABCDE-12345" field="code" state={props.state} />
        <Action label="Find device" state={props.state} primary action="approveCode" />
      </Panel>
    </If>
  </View>;
}
