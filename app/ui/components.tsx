import { type Accessor, type JSX, type ViewStyle, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { PowerBin, type UiState, type Field as FieldName, type CommandName as ActionName } from "relay/native";

export type State = Accessor<UiState>;
export type { FieldName, ActionName };

export const color = {
  bg: "#050a07", panel: "#0a120d", field: "#060d09", line: "#23482e",
  ink: "#d0edcf", muted: "#83a58a", accent: "#9bff9a", accentSoft: "#142a1b",
  warning: "#e0bc76", error: "#ffb39a",
} as const;
export const row = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
export const mono = { fontFamily: "monospace" } as const;
export const small = { ...mono, fontSize: 12, color: color.muted } as const;
export const focus = { outlineWidth: 2, outlineColor: color.accent, outlineOffset: 3 } as const;

export function setField(field: FieldName, value: string) {
  PowerBin.setField(field, value);
}
export function dispatch(action: ActionName, id?: string) {
  PowerBin.dispatch(action, id);
}

export function Panel(props: { children: JSX.Element; style?: ViewStyle }) {
  return <View style={[{
    padding: 22, gap: 18, borderRadius: 2, backgroundColor: color.panel,
    borderWidth: 1, borderColor: color.line,
  }, props.style]}>{props.children}</View>;
}

export function Heading(props: { title: string; subtitle: string }) {
  return <View style={{ gap: 8 }}>
    <Text style={{ ...mono, fontSize: 25, fontWeight: "500", color: color.accent }}>{props.title}</Text>
    <Text style={{ ...mono, fontSize: 13, color: color.muted, lineHeight: 20 }}>{props.subtitle}</Text>
  </View>;
}

export function Field(props: { label: string; placeholder: string; field: FieldName; state: State; masked?: boolean }) {
  return <View style={{ gap: 8 }}>
    <Text style={{ ...small, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>{props.label}</Text>
    <Input
      accessibilityLabel={props.label}
      value={props.state()[props.field]}
      onChange={({ value }) => setField(props.field, value)}
      placeholder={props.placeholder}
      masked={props.masked ?? false}
      autoCorrect={false}
      autoCapitalize="none"
      style={{
        ...mono, fontSize: 14, color: color.ink, placeholderColor: color.muted,
        caretColor: color.accent, selectionColor: color.accentSoft,
        backgroundColor: color.field, borderWidth: 1, borderColor: color.line,
        borderRadius: 2, paddingHorizontal: 14, paddingVertical: 13,
      }}
      focusStyle={{ borderColor: color.accent }}
    />
  </View>;
}

export function Action(props: { label: string; state: State; primary?: boolean; destructive?: boolean; action: ActionName; id?: string }) {
  return <Button
    disabled={props.state().busy}
    onPress={() => dispatch(props.action, props.id)}
    style={{
      minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 2,
      alignItems: "center", justifyContent: "center", borderWidth: 1,
      backgroundColor: props.primary ? color.accent : color.field,
      borderColor: props.destructive ? color.error : props.primary ? color.accent : color.line,
    }}
    hoverStyle={{ borderColor: props.destructive ? color.error : color.accent }}
    focusStyle={focus}
    activeStyle={{ opacity: 0.7 }}
    disabledStyle={{ opacity: 0.45 }}
  >
    <Text style={{ ...mono, fontWeight: "600", fontSize: 12, color: props.destructive ? color.error : props.primary ? color.bg : color.ink }}>{props.label}</Text>
  </Button>;
}

export function timestamp(value: string) {
  return `${value.slice(0, 16).replace("T", " · ")} UTC`;
}

export function fingerprint(value: string) {
  return [...value].map((ch, index) => `${index > 0 && index % 8 === 0 ? (index % 32 === 0 ? "\n" : " ") : ""}${ch}`).join("");
}
