// Keep the original local-space radii: the vertex shader samples position,
// so shrinking geometry itself would change the wavelengths and animation.
export const ORB_GEOMETRY: [number, number, number] = [1.66, 192, 144];
export const ORB_SHELL_GEOMETRY: [number, number, number] = [1.72, 56, 42];
