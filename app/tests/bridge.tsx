// A small client of the real Rust bridge. No bootstrap, pairing, writes, or
// secret values are displayed; edits affect only this engine's form state.
import { cleanup, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { PowerBin, type UiState } from "powerbin/native";

function Observer() {
  const state = signal<UiState | undefined>();
  const stop = PowerBin.onChange((next) => state.set(next));
  cleanup(stop);
  return <View>
    <Text>{state() ? `Observer: ${state()!.draft}` : "Waiting for observer"}</Text>
    <Button onPress={stop}><Text>Stop observer</Text></Button>
  </View>;
}

function Client() {
  const state = signal<UiState | undefined>();
  cleanup(PowerBin.onChange((next) => state.set(next)));
  return <View>
    <Text>{state() ? `Main: ${state()!.draft}` : "Waiting for bridge"}</Text>
    <Text>{state()?.ready ? "Snapshot received" : "Waiting for snapshot"}</Text>
    <Observer />
  </View>;
}

mount(() => {
  const visible = signal(true);
  return <View>
    <Button onPress={() => PowerBin.setField("draft", "Retained across remount")}><Text>Change draft</Text></Button>
    <Button onPress={() => PowerBin.setField("draft", "Changed after unsubscribe")}><Text>Change again</Text></Button>
    <Button onPress={() => visible.set(false)}><Text>Unmount clients</Text></Button>
    <Button onPress={() => visible.set(true)}><Text>Mount clients</Text></Button>
    <If when={visible()}><Client /></If>
  </View>;
});
