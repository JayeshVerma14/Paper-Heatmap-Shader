// Resolve pass: average the accumulation buffer (N temporal sub-samples, each at
// SSAA resolution) down to one output pixel, then dither before the 8-bit write.

export const resolveVertexShader = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_position;
void main() {
  gl_Position = a_position;
}`;

export const resolveFragmentShader = `#version 300 es
precision highp float;

uniform sampler2D u_accum;
uniform float u_invSamples;  // 1 / temporal sample count
uniform int u_ssaa;          // spatial factor, 1..4

out vec4 fragColor;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * u_ssaa;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    if (y >= u_ssaa) break;
    for (int x = 0; x < 4; x++) {
      if (x >= u_ssaa) break;
      sum += texelFetch(u_accum, base + ivec2(x, y), 0);
    }
  }

  float box = float(u_ssaa * u_ssaa);
  vec4 color = sum / box * u_invSamples;

  // One LSB of triangular noise. Without it, averaging many samples produces
  // values so smooth that 8-bit quantisation shows as rings in the glow.
  float n1 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453123);
  float n2 = fract(sin(dot(gl_FragCoord.xy + 17.0, vec2(39.3468, 11.1357))) * 24634.6345345);
  color.rgb += (n1 + n2 - 1.0) / 255.0;

  fragColor = color;
}`;
