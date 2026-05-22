import path from "path";
import fs from "fs";
import { GoogleGenAI, Modality } from "@google/genai";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";

export interface JobState {
  id: string;
  status: 'idle' | 'generating_voice' | 'planning' | 'generating_images' | 'stitching' | 'uploading' | 'completed' | 'failed';
  script: string;
  audioBase64?: string;
  duration?: number;
  progress: number;
  error?: string;
  scenes: {
    timestamp: number;
    prompt: string;
    text: string;
    imageUrl?: string;
    duration?: number;
  }[];
  videoUrl?: string; // final github url
}

export const activeJobs = new Map<string, JobState>();

const generateWithRetry = async (params: any, keys: string[]) => {
  let attempts = 0;
  let lastError = null;
  for (const key of keys) {
    const client = new GoogleGenAI({ apiKey: key });
    try {
      attempts++;
      const res = await client.models.generateContent(params);
      return res;
    } catch (err: any) {
      lastError = err;
      const msg = (err.message || "").toLowerCase();
      if (msg.includes('quota') || msg.includes('429')) continue;
      // Also fail over for other errors
    }
  }
  throw new Error(`Failed after ${attempts} key(s): ` + lastError);
};

export async function runJob(jobId: string, script: string, apiKey: string[], imageWorkers: string[], githubToken: string, selectedVoice: string) {
  const job: JobState = {
    id: jobId,
    status: 'generating_voice',
    script,
    progress: 5,
    scenes: [],
  };
  activeJobs.set(jobId, job);

  const sessionDir = path.join("tmp", jobId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  try {
    // 1. Generate Voice
    console.log(`[${jobId}] Synthesizing voice...`);
    const ttsResponse = await generateWithRetry({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: script }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice || 'Charon' } },
        },
      },
    }, apiKey);

    const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
    if (!base64Audio) throw new Error("Voiceover failed.");
    
    // We get PCM base64 from gemini, we need to convert to WAV to play via FFmpeg and Frontend
    const binary = Buffer.from(base64Audio, 'base64');
    
    const wavBuffer = createWavHeader(binary.length, 24000)
    const audioPath = path.join(sessionDir, "audio.wav");
    fs.writeFileSync(audioPath, Buffer.concat([wavBuffer, binary]));
    
    const audioDuration = binary.length / (24000 * 2);
    job.audioBase64 = Buffer.concat([wavBuffer, binary]).toString('base64');
    job.duration = audioDuration;
    job.status = 'planning';
    job.progress = 15;
    activeJobs.set(jobId, { ...job });

    console.log(`[${jobId}] Planning story... duration: ${audioDuration}s`);
    
    const planResponse = await generateWithRetry({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: script }] }],
      config: {
        systemInstruction: `You are a cinematic video producer. Divide the provided script into chronological segments of roughly 6 seconds each to match the total duration of ${audioDuration.toFixed(1)} seconds.
        For each segment:
        1. "timestamp": start time in seconds.
        2. "prompt": deeply emotional, dark psychological anime style prompt. Unique composition.
        3. "text": exactly matching the script portion.
        Output as a JSON array of objects.`,
        responseMimeType: "application/json",
      }
    }, apiKey);

    let parsedPlan;
    try {
        let text = planResponse.text || "[]";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) text = jsonMatch[0];
        parsedPlan = JSON.parse(text);
    } catch(e) {
        throw new Error("Failed to parse visual plan JSON.");
    }
    
    const PAUSE_DUR = 0.5, WORD_DUR = 0.3;
    const baseDurations = parsedPlan.map((s:any) => ((s.text || "").split(/\s+/).length * WORD_DUR) + PAUSE_DUR);
    const totalBase = baseDurations.reduce((a:number, b:number) => a + b, 0);
    const scale = audioDuration / (totalBase || 1);
    
    let runningTime = 0;
    job.scenes = parsedPlan.map((s: any, i: number) => {
      const startTime = runningTime;
      const duration = baseDurations[i] * scale;
      runningTime += duration;
      return { ...s, timestamp: startTime, duration, prompt: s.prompt || "cinematic" };
    });
    
    job.status = 'generating_images';
    job.progress = 25;
    activeJobs.set(jobId, { ...job });

    console.log(`[${jobId}] Generating images for ${job.scenes.length} scenes...`);
    const imageWorkersCycle = imageWorkers && imageWorkers.length > 0 ? imageWorkers : ["https://worker-blue-shadow-1be1.vaishakhaphotos2.workers.dev"];
    
    for (let i = 0; i < job.scenes.length; i++) {
        const scene = job.scenes[i];
        let workerUrl = imageWorkersCycle[i % imageWorkersCycle.length];
        const fullPrompt = `Deeply dark psychological anime/manga style, heart-touching human vulnerability, cinematic composition, ${scene.prompt}, masterpiece, high quality, expressive shadows, soulful atmosphere, no text.`;
        
        let success = false;
        for(let attempts = 0; attempts < 3 && !success; attempts++) {
           try {
             const sdUrl = "https://worker-blue-shadow-1be1.vaishakhaphotos2.workers.dev"; 
             const finalUrl = workerUrl || sdUrl;
             const res = await axios.post(finalUrl, 
               { inputs: fullPrompt },
               { responseType: 'arraybuffer', timeout: 30000 }
             );
             
             const imgBuffer = Buffer.from(res.data, 'binary');
             const imgPath = path.join(sessionDir, `img_${i}.jpg`);
             fs.writeFileSync(imgPath, imgBuffer);
             
             job.scenes[i].imageUrl = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');
             success = true;
           } catch(err: any) {
             console.warn(`[${jobId}] Image ${i} attempt ${attempts} failed`);
           }
        }
        if (!success) {
            console.error(`Failed to generate image ${i}`);
            const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
            fs.writeFileSync(path.join(sessionDir, `img_${i}.jpg`), pixel);
             job.scenes[i].imageUrl = 'data:image/png;base64,' + pixel.toString('base64');
        }
        
        job.progress = 25 + (i / job.scenes.length) * 40;
        activeJobs.set(jobId, { ...job });
    }

    job.status = 'stitching';
    job.progress = 65;
    activeJobs.set(jobId, { ...job });
    console.log(`[${jobId}] Stitching video...`);

    const concatFilePath = path.join(sessionDir, "concat.txt");
    let concatContent = "";
    for(let i = 0; i < job.scenes.length; i++) {
        concatContent += `file '${path.resolve(sessionDir, `img_${i}.jpg`)}'\n`;
        concatContent += `duration ${job.scenes[i].duration}\n`;
    }
    if (job.scenes.length > 0) {
        concatContent += `file '${path.resolve(sessionDir, `img_${job.scenes.length - 1}.jpg`)}'\n`;
    }
    fs.writeFileSync(concatFilePath, concatContent);

    const outputPath = path.join(sessionDir, "output.mp4");

    await new Promise((resolve, reject) => {
        ffmpeg()
        .input(concatFilePath)
        .inputOptions(["-f concat", "-safe 0"])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-vf scale=1080:1920',
          '-preset fast',
          '-crf 22',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',
          '-movflags +faststart'
        ])
        .save(outputPath)
        .on('end', () => resolve(true))
        .on('error', (err) => reject(err));
    });

    job.status = 'uploading';
    job.progress = 85;
    activeJobs.set(jobId, { ...job });
    console.log(`[${jobId}] Uploading to GitHub releases...`);

    if (githubToken) {
       await uploadToGithubRelease(githubToken, jobId, outputPath);
    }

    job.status = 'completed';
    job.progress = 100;
    activeJobs.set(jobId, { ...job });
    console.log(`[${jobId}] Completely done!`);
    
    setTimeout(() => {
        activeJobs.delete(jobId);
        fs.rm(sessionDir, { recursive: true, force: true }, () => {});
    }, 10 * 60 * 1000);

  } catch (err: any) {
    console.error(`[${jobId}] Job Failed:`, err);
    job.status = 'failed';
    job.error = err.message || "Unknown error";
    activeJobs.set(jobId, { ...job });
  }
}

async function uploadToGithubRelease(token: string, jobId: string, mp4Path: string) {
    const octokit = new (await import("@octokit/rest")).Octokit({ auth: token });
    const { data: user } = await octokit.users.getAuthenticated();
    const owner = user.login;
    const repo = "ai-studio-video-projects";

    try {
      await octokit.repos.get({ owner, repo });
    } catch(e: any) {
      if (e.status === 404) {
         await octokit.repos.createForAuthenticatedUser({ name: repo, private: true, auto_init: true });
         await new Promise(r => setTimeout(r, 3000));
      } else {
         throw e;
      }
    }

    const { data: release } = await octokit.repos.createRelease({
      owner, repo, tag_name: `vid-${jobId}`, name: `Video ${jobId}`,
      body: "Rendered backend MP4", draft: false, prerelease: false
    });

    const fileData = fs.readFileSync(mp4Path);
    await axios.post(
      release.upload_url.replace("{?name,label}", `?name=output.mp4`),
      fileData,
      {
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'video/mp4'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );
}

function createWavHeader(dataLength: number, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); 
  header.writeUInt16LE(1, 20); 
  header.writeUInt16LE(1, 22); 
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); 
  header.writeUInt16LE(2, 32); 
  header.writeUInt16LE(16, 34); 
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}
