import { Text, View } from "nsh";
import { Action, color, Heading, mono, Panel, small, timestamp, type State } from "./components";

export function Guest(props: { state: State }) {
  return <View style={{ gap: 22 }}>
    <Heading title="One-time message." />
    <If when={!!props.state().guest?.expiresAt} else={
      <Panel>
        <Text style={{ ...mono, fontSize: 18, color: color.ink }}>{props.state().guest?.unavailable ? "This link is unavailable." : "Checking this link…"}</Text>
      </Panel>
    }>
      <Panel>
        <Text style={small}>{`Expires ${timestamp(props.state().guest?.expiresAt ?? "")}`}</Text>
        <If when={props.state().guest?.revealed != null} else={
          <View style={{ gap: 16 }}>
            <Action label="Reveal & burn" state={props.state} primary action="reveal" />
          </View>
        }>
          <View style={{ gap: 16 }}>
            <Text style={{ ...mono, fontSize: 16, color: color.ink }}>{props.state().guest?.revealed ?? ""}</Text>
            <Action label="Copy snippet" state={props.state} primary action="copyOutput" />
            <Text style={{ ...mono, fontSize: 12, color: color.muted }}>The link is now consumed.</Text>
          </View>
        </If>
      </Panel>
    </If>
  </View>;
}
