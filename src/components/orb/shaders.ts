// Approved HD Subtle shaders from docs/references/lain-noise-orb-hd-subtle.html.
// Keep reference formulas intact; refinement is fixed to 1 (HD mode).

export const orbVertexShader = /* glsl */ `
uniform float time;uniform float energy;uniform float pulse;uniform float glitch;
varying vec3 vNormal;varying vec3 vPos;varying vec2 vUv;
void main(){
 vUv=uv;
 vec3 n=normalize(position);
 // EXACT spatial wave formulation from the 2026 original Four Prototypes demo.
 float wave=sin(position.x*5.8+time*(.65+energy*2.))
          *sin(position.y*6.4-time*.88)
          *sin(position.z*4.8+time*.7);
 float detail=sin(position.y*13.+position.x*6.+time*(.8+energy*2.5))*.5;
 float displacement=(wave*.20+detail*.045)*(1.+energy*.75+pulse*1.8);
 vec3 pos=position+n*(displacement+glitch*.07*sin(position.y*55.+time*40.));
 vPos=pos;vNormal=normalize(normalMatrix*normal);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.);
}`;

export const orbFragmentShader = /* glsl */ `
uniform float time;uniform float energy;uniform float pulse;uniform float refinement;
varying vec3 vNormal;varying vec3 vPos;varying vec2 vUv;
void main(){
 float f=pow(1.-abs(dot(normalize(vNormal),vec3(0.,0.,1.))),1.9);
 float waves=sin(vPos.y*17.+vPos.x*8.+time*2.)*.5+.5;
 // Original shader grid; retained for direct visual comparison.
 float grid=min(abs(fract(vUv.x*29.)-.5),abs(fract(vUv.y*19.)-.5));
 float oldLines=1.-smoothstep(.01,.055,grid);
 // Better-defined, derivative-antialiased intersections of latitude/longitude lines.
 vec2 cell=abs(fract(vUv*vec2(29.,19.))-.5);
 vec2 aa=max(fwidth(vUv*vec2(29.,19.))*1.1,vec2(.005));
 vec2 profile=1.-smoothstep(vec2(.012),vec2(.012)+aa,cell);
 float fineLines=max(profile.x,profile.y);
 float lines=mix(oldLines,fineLines,refinement);
 vec3 originalColor=mix(vec3(.12,.055,.045),vec3(.90,.52,.25),clamp(f*.9+lines*.52+waves*.24+pulse*.4,0.,1.));
 // Amber stays restrained: the finest contour lines receive the highlight.
 vec3 refinedColor=mix(vec3(.16,.066,.042),vec3(.80,.43,.22),clamp(f*.66+lines*.35+waves*.14+pulse*.18,0.,1.));
 vec3 col=mix(originalColor,refinedColor,refinement);
 float oldAlpha=clamp(.20+f*.58+oldLines*.18+pulse*.18,0.,.95);
 float refinedAlpha=clamp(.065+f*.16+fineLines*.21+pulse*.065,0.,.62);
 float alpha=mix(oldAlpha,refinedAlpha,refinement);
 gl_FragColor=vec4(col,alpha);
}`;
