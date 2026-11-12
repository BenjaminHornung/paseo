const desktopDistribution =
  typeof window === "undefined" ? undefined : window.paseoDesktop?.distribution;
export const isAdvancedDistribution = desktopDistribution
  ? desktopDistribution === "advanced"
  : process.env.EXPO_PUBLIC_PASEO_DISTRIBUTION === "advanced";
export const appDisplayName = isAdvancedDistribution ? "Paseo Advanced" : "Paseo";
export const appCliName = isAdvancedDistribution ? "paseo-advanced" : "paseo";
