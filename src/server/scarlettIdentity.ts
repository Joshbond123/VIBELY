import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ContentSeriesSpec {
  id: string;
  name: string;
  weight: number; // Percentage 0..100
  description: string;
  signatureElements: string[];
  allowTwerkAccent: boolean;
  outfitTransition: boolean;
}

export const SCARLETT_CONTENT_SERIES: ContentSeriesSpec[] = [
  {
    id: 'hip_movement_challenge',
    name: 'THE HIP MOVEMENT CHALLENGE',
    weight: 35,
    description: 'Short, catchy dance videos featuring rhythmic hip movements, smooth body rolls, confident choreography, and engaging camera angles.',
    signatureElements: [
      'Rhythmic hip movements',
      'Smooth body rolls',
      'Confident choreography',
      'Natural body movement and realistic secondary motion',
      'Attractive dance poses',
      'Engaging social-media influencer camera angles',
    ],
    allowTwerkAccent: true,
    outfitTransition: false,
  },
  {
    id: 'bounce_dance',
    name: 'THE BOUNCE DANCE',
    weight: 30,
    description: 'Energetic dance challenges featuring rhythmic full-body movement, natural body bounce, playful expressions, and beat-locked choreography.',
    signatureElements: [
      'Rhythmic full-body movement',
      'Natural body bounce with realistic gravity and momentum',
      'Playful flirtatious facial expressions and eye contact',
      'Catchy viral-style choreography',
      'Smooth camera and movement transitions',
      'Dance movements tightly synchronized with the Amapiano + Afrobeats log drums',
    ],
    allowTwerkAccent: true,
    outfitTransition: false,
  },
  {
    id: 'bodycon_transition',
    name: 'THE BODYCON TRANSITION',
    weight: 20,
    description: 'Stylish outfit-transformation videos starting in casual fashion and transitioning smoothly on the musical drop into a glamorous figure-hugging bodycon dress.',
    signatureElements: [
      'Starting in stylish casual clothing (fitted crop top, off-shoulder top, or lounge set)',
      'Seamless beat-matched outfit transition on the musical drop',
      'Glamorous, figure-hugging luxury bodycon mini or evening dress',
      'Fashionable accessories, heels, and luxury styling',
      'Confident runway walk and seductive final poses',
      'Attractive cinematic tracking and three-quarter shots',
    ],
    allowTwerkAccent: false,
    outfitTransition: true,
  },
  {
    id: 'gym_challenge',
    name: 'THE GYM CHALLENGE',
    weight: 15,
    description: 'Athletic luxury fitness videos featuring glute workouts, squats, hip thrusts, fashionable form-fitting gymwear, and anatomically accurate biomechanics.',
    signatureElements: [
      'Targeted glute exercises with realistic form',
      'Controlled deep squats and hip thrusts',
      'Cohesive multi-angle luxury gym fitness routine',
      'Fashionable form-fitting scrunch leggings and supportive sports crop top',
      'Realistic exercise biomechanics, foot placement, and weight distribution',
      'Confident post-set mirror/camera interaction synchronized to upbeat rhythm',
    ],
    allowTwerkAccent: false,
    outfitTransition: false,
  },
];

export function selectWeightedSeries(): ContentSeriesSpec {
  const totalWeight = SCARLETT_CONTENT_SERIES.reduce((acc, s) => acc + s.weight, 0);
  // Cryptographic uniform float in [0, totalWeight)
  const randInt = crypto.randomInt(0, 1_000_000);
  const roll = (randInt / 1_000_000) * totalWeight;
  let cumulative = 0;
  for (const series of SCARLETT_CONTENT_SERIES) {
    cumulative += series.weight;
    if (roll < cumulative) {
      return series;
    }
  }
  return SCARLETT_CONTENT_SERIES[0];
}

export const SCARLETT_PERMANENT_IDENTITY_PROMPT = `SCARLETT MONROE – PERMANENT AI VIDEO IDENTITY INSTRUCTION

1. CHARACTER IDENTITY
Scarlett Monroe is a fictional 25-year-old adult female fashion, beauty and lifestyle influencer.
She has a glamorous, seductive, confident and exceptionally feminine appearance. Her visual identity must remain consistent across every generated image and video.
She has a distinctive, exaggerated hourglass figure featuring:
- A very full, prominent bust.
- A narrow, defined waist.
- Wide, curvaceous hips.
- A very full, rounded backside.
- Thick, shapely thighs.
- Smooth, feminine body proportions.
Her figure must remain visually consistent and anatomically coherent in every scene.

2. FACIAL APPEARANCE
Maintain Scarlett's established facial identity:
- Long, thick platinum-blonde hair with visible natural strands.
- Beautiful icy-blue eyes.
- Fair, realistic skin complexion with natural pores, fine facial details, and natural skin highlights.
- Defined cheekbones and elegant facial structure.
- Full, naturally shaped lips.
- Attractive, feminine facial proportions.
Her face must never randomly change between frames, scenes, or videos. Avoid plastic-looking skin, beauty filters, or cartoon features.

3. SIGNATURE FASHION AND CLOTHING
Fashionable, seductive, attractive, figure-enhancing wardrobe emphasizing her hourglass silhouette with realistic fabric tension, stretching, folds, stitching, and natural fabric physics:
- Dresses: Fitted bodycon mini dresses, elegant low-cut dresses, tight designer evening dresses, backless cocktail dresses.
- Swimwear: Luxury bikinis, high-cut bikini bottoms, poolside/beach resort wear.
- Casual/Athleisure: Tight crop tops, fitted tank tops, mini skirts/shorts, form-fitting gym leggings, off-shoulder streetwear, high heels or luxury sneakers appropriate to the scene.

4. REALISTIC BODY MOVEMENT AND PHYSICS
Scarlett moves like a real human woman with believable biomechanics, natural weight distribution, momentum, and accurate secondary movement:
- Breast movement: Natural gravity/momentum response, subtle secondary motion relative to activity intensity, realistic fabric support and compression.
- Backside & hip movement: Natural weight-transfer sway when walking; physically believable rhythmic hip movement and glute motion during dancing, body rolls, and squats.
- Full-body coordination: Synchronized shoulder, spine/torso rotation, waist, arm/hand gestures, knee/ankle flexion, and grounded foot placement.

5. PERFORMANCE, CAMERA & ULTRA-PHOTOREALISM
- Confident, glamorous, playful, flirtatious eye contact, natural blinking, warm subtle smiles.
- Professional social-media influencer cinematography: full-body and three-quarter framing, smooth tracking shots, natural lighting and shadows.
- Strictly avoid: robotic or stiff movement, distorted anatomy, extra limbs/fingers, floating feet, flickering garments, changing facial identity, plastic/wax skin, cartoon/3D-avatar rendering.`;

export const SCARLETT_NEGATIVE_PROMPT =
  'cartoon, anime, 3d render, cgi, video game avatar, plastic skin, wax skin, airbrushed face, changing face, brown hair, dark eyes, robotic movement, stiff hips, frozen body, distorted anatomy, extra fingers, extra limbs, floating feet, flickering clothing, abrupt jump cuts, blurry lowres, watermark, text overlay';

export interface PersistentReferenceAsset {
  id: string;
  filename: string;
  label: string;
  role: string;
  sourceCode: string;
  localPath: string;
  mediaUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
}

const REFERENCE_META = [
  {
    id: 'ref_1',
    filename: 'scarlett_ref_1.jpg',
    label: 'Reference 1 — Full-Body Front Proportions',
    role: 'Primary full-body hourglass silhouette, platinum-blonde hair, and front posture anchor (<Picture 1>)',
    sourceCode: 'ibb.co/ycfvztY5',
    width: 784,
    height: 1168,
  },
  {
    id: 'ref_2',
    filename: 'scarlett_ref_2.jpg',
    label: 'Reference 2 — Full-Body Back & Over-Shoulder Profile',
    role: 'Backside proportions, waist-to-hip curvature, and over-the-shoulder profile anchor (<Picture 3>)',
    sourceCode: 'ibb.co/CxM1NRT',
    width: 784,
    height: 1168,
  },
  {
    id: 'ref_3',
    filename: 'scarlett_ref_3.jpg',
    label: 'Reference 3 — High-Res Facial Identity & Upper Portrait',
    role: 'High-definition facial structure, icy-blue eyes, full lips, and realistic skin texture anchor (<Picture 2>)',
    sourceCode: 'ibb.co/SXh9CFTV',
    width: 1696,
    height: 2528,
  },
];

export function ensurePersistentReferences(dataDir: string, repoRoot: string): PersistentReferenceAsset[] {
  const targetDir = path.join(dataDir, 'references');
  fs.mkdirSync(targetDir, { recursive: true });
  const bundledDir = path.join(repoRoot, 'assets', 'references');

  return REFERENCE_META.map((meta) => {
    const destPath = path.join(targetDir, meta.filename);
    const bundledPath = path.join(bundledDir, meta.filename);
    if (!fs.existsSync(destPath) && fs.existsSync(bundledPath)) {
      fs.copyFileSync(bundledPath, destPath);
    }
    let sizeBytes = 0;
    let sha256 = '';
    let verified = false;
    if (fs.existsSync(destPath)) {
      const buf = fs.readFileSync(destPath);
      sizeBytes = buf.length;
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      verified = sizeBytes > 50_000;
    }
    return {
      ...meta,
      localPath: destPath,
      mediaUrl: `/media/references/${meta.filename}`,
      sizeBytes,
      sha256,
      verified,
    };
  });
}
