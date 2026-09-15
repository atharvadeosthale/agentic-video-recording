import { defineScenario } from "../src/index.js";
import { fileURLToPath } from "node:url";

const url = new URL("./demo-site/index.html", import.meta.url).href;

export default defineScenario(
  {
    name: "demo",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
    output: { width: 1920, height: 1080, fps: 60 },
  },
  async (s) => {
    await s.goto(url);
    await s.hover("text=Projects");
    await s.startRecording();
    await s.wait(500);
    await s.type("#name", "agentic-demo", { wpm: 200, mistakes: 0.05 });
    await s.click("#create");
    await s.waitFor("text=deployed");
    await s.wait(1200);
    await s.zoom("#status", { scale: 1.8 });
    await s.wait(1200);
    await s.zoomOut();
    await s.hover(".card:nth-child(2)");
    await s.wait(600);
    await s.scrollTo("text=Recent deployments", { block: "start" });
    await s.wait(1000);
    await s.stopRecording();
  },
);
