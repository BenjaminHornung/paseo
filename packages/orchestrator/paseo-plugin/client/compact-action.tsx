import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text } from "react-native";

export function CompactAction({
  label,
  icon,
  onPress,
  disabled,
  iconOnly,
  theme,
}: {
  label: string;
  icon?: string;
  onPress(): void;
  disabled?: boolean;
  iconOnly?: boolean;
  theme: PluginSurfaceProps["theme"];
}) {
  const [focused, setFocused] = useState(false),
    [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        minHeight: 28,
        paddingHorizontal: 5,
        paddingVertical: 3,
        flexDirection: "row",
        gap: 4,
        alignItems: "center",
        borderWidth: 1,
        borderColor: focused ? theme.colors.accent : "transparent",
        borderRadius: 5,
        backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon && <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />}
      {!iconOnly && (
        <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>{label}</Text>
      )}
    </Pressable>
  );
}
