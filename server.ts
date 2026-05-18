import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const upload = multer({ dest: "tmp/" });

// Ensure tmp directory exists
if (!fs.existsSync("tmp")) {
  fs.mkdirSync("tmp");
}

ffmpeg.getAvailableFormats((err) => {
  if (err) {
    console.error("FFMPEG INITIALIZATION ERROR:", err);
  } else {
    console.log("FFMPEG is ready and available.");
  }
});

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Middleware
  app.use(express.json({ limit: "200mb" }));
  app.use(express.urlencoded({ limit: "200mb", extended: true }));
  
  // Convert WebM to MP4 endpoint
  app.post("/api/video/render", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }
    
    console.log("Received video file to convert:", req.file.path);
    const inputPath = req.file.path;
    const outputPath = path.join("tmp", `${req.file.filename}.mp4`);
    
    // Convert the webm to mp4
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 192k',
        '-movflags +faststart'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log("Conversion finished! Sending MP4 back.");
        res.download(outputPath, "final_video.mp4", (err) => {
          if (err) console.error("Error sending file:", err);
          
          // Cleanup
          fs.unlink(inputPath, () => {});
          fs.unlink(outputPath, () => {});
        });
      })
      .on('error', (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Conversion failed" });
        // Cleanup
        fs.unlink(inputPath, () => {});
      });
  });

  // Server-side FFmpeg Stitching endpoint
  app.post("/api/video/stitch", async (req, res) => {
    console.log(`Received stitch request with ${req.body?.scenes?.length || 0} scenes.`);
    const { scenes, audioBase64 } = req.body;
    
    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "No scenes provided" });
    }

    const sessionId = Date.now().toString();
    const sessionDir = path.join("tmp", sessionId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    try {
      const imagePaths: string[] = [];
      const concatFilePath = path.join(sessionDir, "concat.txt");
      let concatContent = "";

      // Save audio
      const audioPath = path.join(sessionDir, "audio.wav");
      const audioBuffer = Buffer.from(audioBase64, "base64");
      fs.writeFileSync(audioPath, audioBuffer);

      // Process scenes
      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const imgPath = path.join(sessionDir, `img_${i}.webp`);
        
        if (scene.imageUrl.startsWith("data:")) {
          const baseData = scene.imageUrl.split(",")[1];
          fs.writeFileSync(imgPath, Buffer.from(baseData, "base64"));
        } else if (scene.imageUrl.startsWith("http")) {
          try {
            // Download if it's a URL
            const response = await axios.get(scene.imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
            fs.writeFileSync(imgPath, response.data);
          } catch (dlErr) {
            console.error(`Failed to download image from ${scene.imageUrl}`, dlErr);
            continue;
          }
        } else {
          console.warn(`Invalid image URL at scene ${i}:`, scene.imageUrl);
          // Create a dummy black image or skip? Let's skip and see if it breaks concat.
          // Better: skip from concat if image missing
          continue;
        }
        
        imagePaths.push(imgPath);
        
        // Calculate duration: if it's the last scene, we might need a default or use the total audio length
        // But for now we rely on the duration provided by the client
        concatContent += `file '${path.resolve(imgPath)}'\n`;
        concatContent += `duration ${scene.duration}\n`;
      }
      
      // FFmpeg quirk: last image needs to be repeated or it might be cut off
      if (scenes.length > 0) {
        concatContent += `file '${path.resolve(imagePaths[imagePaths.length - 1])}'\n`;
      }

      fs.writeFileSync(concatFilePath, concatContent);

      const outputPath = path.join(sessionDir, "output.mp4");

      console.log("Starting FFmpeg stitch for session:", sessionId);

      ffmpeg()
        .input(concatFilePath)
        .inputOptions(["-f concat", "-safe 0"])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-preset fast',
          '-crf 22',
          '-c:a aac',
          '-b:a 192k',
          '-shortest', // Finish when audio ends
          '-movflags +faststart'
        ])
        .save(outputPath)
        .on('end', () => {
          console.log("Stitching finished! Sending MP4 back.");
          res.download(outputPath, "video.mp4", (err) => {
            if (err) console.error("Error sending file:", err);
            
            // Cleanup session directory
            setTimeout(() => {
              fs.rm(sessionDir, { recursive: true, force: true }, () => {});
            }, 10000); // 10s delay to ensure file is sent
          });
        })
        .on('error', (err) => {
          console.error("FFmpeg stitching error:", err);
          res.status(500).json({ error: "Stitching failed: " + err.message });
          fs.rm(sessionDir, { recursive: true, force: true }, () => {});
        });

    } catch (error: any) {
      console.error("Setup error for stitching:", error);
      res.status(500).json({ error: error.message });
      fs.rm(sessionDir, { recursive: true, force: true }, () => {});
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
