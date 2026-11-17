// Display snapshots exercise the shared workspace without opening a database
// or depending on a running pairing server.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { UiState } from "powerbin/native";
import { Workspace } from "../ui/workspace";

const currentDevice = { id: "this-device", name: "My laptop", publicKey: "laptop-public-key" };
const peer = { id: "other-device", name: "My phone", publicKey: "phone-public-key" };

mount(() => {
  const state = signal<UiState>({
    ready: true,
    session: { deviceId: currentDevice.id, name: currentDevice.name, origin: "https://api.example.test" },
    items: [], devices: [currentDevice], draft: "", recipient: "", tab: "send",
    status: "Connected", error: "", busy: false, origin: "https://api.example.test",
    name: currentDevice.name, deviceName: "", code: "", bootstrapToken: "",
    pairing: null, guest: null, output: "", pairingUrl: "https://my-relay.example.test/powerbin/",
  });
  const update = (patch: Partial<UiState>) => state.set({ ...state(), ...patch });
  return <View>
    <View>
      <Button onPress={() => update({ devices: [currentDevice, peer], pairing: null })}><Text>Add trusted peer</Text></Button>
      <Button onPress={() => update({ devices: [currentDevice] })}><Text>Remove trusted peer</Text></Button>
      <Button onPress={() => update({ devices: [] })}><Text>Clear synced devices</Text></Button>
      <Button onPress={() => update({ draft: "Keep this draft while pairing" })}><Text>Prepare draft</Text></Button>
      <Button onPress={() => update({ pairingUrl: "" })}><Text>Clear web address</Text></Button>
      <Button onPress={() => update({ tab: "devices" })}><Text>Show devices</Text></Button>
      <Button onPress={() => update({ pairing: {
        code: "ABCDE-12345", fingerprint: "0123456789ABCDEF", peerName: peer.name, canConfirm: true,
      } })}><Text>Show pairing confirmation</Text></Button>
    </View>
    <Workspace state={state} />
  </View>;
});
