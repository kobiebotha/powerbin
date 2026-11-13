import { computed, Text, View } from "nsh";
import { Button, Input, Tab, Tabs } from "nsh/base";
import { Action, color, focus, mono, Panel, row, setField, small, timestamp, type State } from "./components";
import { Devices } from "./pairing";

const tabs = [
  { key: "send", label: "Send" }, { key: "inbox", label: "Inbox" },
  { key: "saved", label: "Saved" }, { key: "devices", label: "Devices" },
];

export function Workspace(props: { state: State }) {
  return <View style={{ gap: 25 }}>
    <Tabs style={{ flexDirection: "row", gap: 4, paddingBottom: 10, borderBottomWidth: 1, borderColor: color.line }}>
      <Each of={tabs} key={(tab) => tab.key}>
        {(tab) => <Tab
          selected={props.state().tab === tab().key}
          onPress={() => setField("tab", tab().key)}
          style={{
            flex: 1, minHeight: 42, borderRadius: 2, alignItems: "center", justifyContent: "center",
            backgroundColor: props.state().tab === tab().key ? color.accentSoft : color.bg,
            borderWidth: 1, borderColor: props.state().tab === tab().key ? color.line : color.bg,
          }} hoverStyle={{ borderColor: color.accent }} focusStyle={focus}>
          <Text style={{ ...mono, fontSize: 12, fontWeight: "500", color: props.state().tab === tab().key ? color.accent : color.muted }}>{props.state().tab === tab().key ? `[ ${tab().label} ]` : tab().label}</Text>
        </Tab>}
      </Each>
    </Tabs>
    <If when={props.state().tab === "send"}><Composer state={props.state} /></If>
    <If when={props.state().tab === "inbox"}><ItemList state={props.state} saved={false} /></If>
    <If when={props.state().tab === "saved"}><ItemList state={props.state} saved /></If>
    <If when={props.state().tab === "devices"}><Devices state={props.state} /></If>
  </View>;
}

function Composer(props: { state: State }) {
  const devices = computed(() => props.state().devices.filter((device) => device.id !== props.state().session?.deviceId));
  return <View style={{ gap: 18 }}>
    <Panel>
      <Input
        accessibilityLabel="Snippet" multiline value={props.state().draft}
        onChange={({ value }) => setField("draft", value)}
        placeholder="Type or paste your text…" autoCorrect={false} maxLength={8000}
        style={{
          ...mono, fontSize: 15, lineHeight: 24, color: color.ink, placeholderColor: color.muted, backgroundColor: color.field,
          caretColor: color.accent, selectionColor: color.accentSoft,
          borderWidth: 1, borderColor: color.line, borderRadius: 2, padding: 18, minHeight: 200,
        }}
        focusStyle={{ borderColor: color.accent }}
      />
      <Text style={small}>select a device to send to. no selection sends to all by default.</Text>
      <View style={row}>
        <Each of={devices()} key={(device) => device.id}>
          {(device) => <Button
            selected={props.state().recipient === device().id}
            onPress={() => setField("recipient", props.state().recipient === device().id ? "" : device().id)}
            style={{
              minHeight: 40, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 2, borderWidth: 1,
              backgroundColor: props.state().recipient === device().id ? color.accentSoft : color.field,
              borderColor: props.state().recipient === device().id ? color.accent : color.line,
            }} hoverStyle={{ borderColor: color.accent }} focusStyle={focus}>
            <Text style={{ ...mono, fontSize: 12, color: props.state().recipient === device().id ? color.accent : color.ink }}>{device().name}</Text>
          </Button>}
        </Each>
      </View>
      <If when={devices().length === 0}>
        <Text style={small}>Pair another device in Devices to start sending.</Text>
      </If>
      <View style={row}>
        <Action label="Send" state={props.state} primary action="send" />
        <Action label="Save for later" state={props.state} action="save" />
        <Action label="Create one-time link" state={props.state} action="createLink" />
      </View>
    </Panel>
    <If when={props.state().output.length > 0}>
      <Panel style={{ borderColor: color.accent }}>
        <Text style={{ ...mono, fontSize: 14, color: color.accent }}>Your one-time link is ready.</Text>
        <Text style={{ ...mono, fontSize: 12, color: color.ink, numberOfLines: 3 }}>{props.state().output}</Text>
        <Action label="Copy link" state={props.state} primary action="copyOutput" />
      </Panel>
    </If>
  </View>;
}

function ItemList(props: { state: State; saved: boolean }) {
  const items = computed(() => props.state().items.filter((item) => item.kind === (props.saved ? "saved" : "transfer")));
  return <View style={{ gap: 18 }}>
    <If when={items().length === 0}>
      <Panel style={{ paddingVertical: 36, alignItems: "center", gap: 12 }}>
        <Text style={{ ...mono, fontSize: 24, color: color.accent }}>{props.saved ? "[ + ]" : "[ · ]"}</Text>
        <Text style={{ ...mono, fontSize: 16, color: color.ink }}>{props.saved ? "Nothing saved yet." : "All clear."}</Text>
        <Text style={small}>{props.saved ? "Save a snippet from the Send tab." : "Your next handoff will arrive here."}</Text>
      </Panel>
    </If>
    <Each of={items()} key={(item) => item.id}>
      {(item) => <Panel style={{ gap: 17 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ ...mono, fontSize: 12, color: color.accent }}>{item().senderName}</Text>
          <Text style={{ ...small, fontSize: 10, letterSpacing: 1 }}>{props.saved ? "SAVED" : "ONE-TIME"}</Text>
        </View>
        <Text style={{ ...mono, fontSize: 15, lineHeight: 23, color: color.ink, numberOfLines: 5 }}>{item().plaintext}</Text>
        <Text style={{ ...small, fontSize: 11 }}>
          {item().expiresAt ? `Expires ${timestamp(item().expiresAt!)}` : "Available until you delete it"}
        </Text>
        <View style={row}>
          <Action label={props.saved ? "Copy snippet" : "Copy & burn"} state={props.state} primary
            action={props.saved ? "copySaved" : "copyBurn"} id={item().id} />
          <Action label="Delete" state={props.state} action="burn" id={item().id} />
        </View>
      </Panel>}
    </Each>
  </View>;
}
