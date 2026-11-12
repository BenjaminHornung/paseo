import { Image } from "react-native";
import { useMemo } from "react";
import { isAdvancedDistribution } from "@/constants/app-brand";
import { PaseoLogo } from "./paseo-logo";

export function AppLogo({ size = 64, color }: { size?: number; color?: string }) {
  const style = useMemo(() => ({ width: size, height: size }), [size]);
  if (!isAdvancedDistribution) return <PaseoLogo size={size} color={color} />;

  return <Image source={require("../../../assets/images/advanced/icon.png")} style={style} />;
}
