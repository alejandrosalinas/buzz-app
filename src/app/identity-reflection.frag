precision mediump float;

uniform vec2 u_size;
uniform vec2 u_origin;
uniform vec2 u_tilt;
uniform vec3 u_accent;
uniform float u_magnetic;
uniform float u_paper;
uniform float u_film;

void main() {
  vec2 uv = (gl_FragCoord.xy - u_origin) / u_size;
  vec3 normal = normalize(vec3(u_tilt * 0.12, 1.0));
  vec3 view = normalize(vec3((uv - 0.5) * 0.65, 1.0));
  vec3 reflected = reflect(-view, normal);
  // Broad studio lights reflected by a satin surface, rather than a sharp streak.
  float curve = sin(reflected.y * 5.0 + u_tilt.x * 0.5) * 0.22;
  float light = exp(-pow((dot(reflected.xy, vec2(1.1, 0.7)) + curve) * 3.0, 2.0));
  float edge = pow(1.0 - max(dot(view, normal), 0.0), 2.0);
  float field = smoothstep(-0.5, 0.5, reflected.y + sin(reflected.x * 4.0 + u_tilt.y * 0.5) * 0.2);
  vec3 pigment = mix(u_accent * 0.45, u_accent, field);
  vec3 finish = mix(pigment, vec3(1.0), light * 0.4 + edge * 0.3);
  float blocks = floor(clamp(dot(reflected.xy, vec2(1.5, 0.6)) + 0.5, 0.0, 0.999) * 5.0) / 4.0;
  vec3 satin = mix(u_accent * 0.7, u_accent, blocks);
  vec3 paper = mix(vec3(0.2), vec3(0.9), light);
  gl_FragColor = vec4(mix(mix(finish, satin, u_magnetic), paper, u_paper), mix(mix(0.65, 0.3, u_magnetic), 0.18, u_paper));
  if (u_film > 0.5) {
    // A soft moving band fades before the artwork edge, without a corner cutout.
    float sweep = dot(uv - 0.5, vec2(1.0, 0.6)) + dot(u_tilt, vec2(0.3, 0.2));
    vec2 inset = min(uv, 1.0 - uv);
    float feather = smoothstep(0.0, 0.2, min(inset.x, inset.y));
    float shimmer = exp(-sweep * sweep * 12.0);
    gl_FragColor = vec4(vec3(1.0), shimmer * feather * 0.1);
  }
}
