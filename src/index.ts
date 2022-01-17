import { watch } from "chokidar";
import findRoot from "find-root";
import findWorkspaceRoot from "find-yarn-workspace-root";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import process from "process";
import readline from "readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { EsBuildCompiler } from "./EsBuildCompiler";
import { MiniServer } from "./mini-server";
import { RunOptions } from "./Options";
import { Project } from "./Project";
import { Supervisor } from "./Supervisor";
import { SwcCompiler } from "./SwcCompiler";
import * as telemetry from "./Telemetry";
import { log, projectConfig } from "./utils";
import {BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor} from "@opentelemetry/sdk-trace-base";
import {SpanStatusCode, trace} from "@opentelemetry/api";
import {JaegerExporter} from "@opentelemetry/exporter-jaeger";
import {Resource} from "@opentelemetry/resources";
import {SemanticResourceAttributes} from "@opentelemetry/semantic-conventions";
import {tracer} from "./Telemetry";

export const cli = async () => {
  const args = yargs(hideBin(process.argv))
    .parserConfiguration({
      "unknown-options-as-args": true,
    })
    .option("commands", {
      alias: "c",
      type: "boolean",
      description:
        "Trigger commands by watching for them on stdin. Prevents stdin from being forwarded to the process. Only command right now is `rs` to restart the server.",
      default: false,
    })
    .option("watch", {
      alias: "w",
      type: "boolean",
      description: "Trigger restarts by watching for changes to required files",
      default: true,
    })
    .option("supervise", {
      alias: "s",
      type: "boolean",
      description: "Supervise and restart the process when it exits indefinitely",
      default: false,
    })
    .option("swc", {
      type: "boolean",
      description: "Use SWC instead of esbuild",
      default: false,
    }).argv;

  return await esbuildDev({
    argv: args._ as any,
    terminalCommands: args.commands,
    reloadOnChanges: args.watch,
    supervise: args.supervise,
    useSwc: args.swc,
  });
};

const startTerminalCommandListener = (project: Project) => {
  const reader = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  reader.on("line", (line: string) => {
    if (line.trim() === "rs") {
      log.info("Restart command received, restarting...");
      void project.invalidateBuildSetAndReload();
    }
  });

  project.addShutdownCleanup(() => reader.close());

  return reader;
};

const startFilesystemWatcher = (project: Project) => {
  const watcher = watch([], { ignoreInitial: true });

  project.supervisor.on("message", (value) => {
    if (value.require) {
      if (!value.require.includes("node_modules")) {
        watcher.add(value.require);
      }
    }
  });

  const reload = (path: string) => project.enqueueReload(path, false);
  const invalidateAndReload = (path: string) => project.enqueueReload(path, true);

  watcher.on("change", reload);
  watcher.on("add", invalidateAndReload);
  watcher.on("addDir", invalidateAndReload);
  watcher.on("unlink", invalidateAndReload);
  watcher.on("unlinkDir", invalidateAndReload);

  project.watcher = watcher;
  project.addShutdownCleanup(() => void watcher.close());

  return watcher;
};

const startIPCServer = async (socketPath: string, project: Project) => {
  const compile = async (filename: string) => {
    try {
      await project.compiler.compile(filename);
      project.watcher?.add(filename);
      return await project.compiler.fileGroup(filename);
    } catch (error) {
      log.error(`Error compiling file ${filename}:`, error);
    }
  };

  const server = new MiniServer({
    "/compile": async (request, reply) => {
      const results = await compile(request.body);
      reply.json({ filenames: results });
    },
    "/file-required": (request, reply) => {
      for (const filename of request.json()) {
        project.watcher?.add(filename);
      }
      reply.json({ status: "ok" });
    },
  });

  log.debug(`Starting supervisor server at ${socketPath}`);
  await server.start(socketPath);

  project.addShutdownCleanup(() => server.close());

  return server;
};

const childProcessArgs = () => {
  return ["-r", path.join(__dirname, "child-process-registration.js"), "-r", require.resolve("@cspotcode/source-map-support/register")];
};

export const esbuildDev = async (options: RunOptions) => {
  const workspaceRoot = findWorkspaceRoot(process.cwd()) || process.cwd();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "esbuild-dev"));
  log.debug(`starting esbuild-dev for workspace root ${workspaceRoot} and workdir ${workDir}`);

  let serverSocketPath: string;
  if (os.platform() === "win32") {
    serverSocketPath = path.join("\\\\?\\pipe", workDir, "ipc.sock");
  } else {
    serverSocketPath = path.join(workDir, "ipc.sock");
  }

  const config = await projectConfig(findRoot(process.cwd()));
  const compiler = options.useSwc ? new SwcCompiler(workspaceRoot, workDir) : new EsBuildCompiler(workspaceRoot, workDir);

  telemetry.setup({ jaegerUrl: 'http://localhost:14268/api/traces', console: true });

  const project = new Project(workspaceRoot, config, compiler);
  project.supervisor = new Supervisor([...childProcessArgs(), ...options.argv], serverSocketPath, options, project);

  log.info("start span");
  const span = tracer.startSpan("main");
  span.setStatus({code: SpanStatusCode.OK});

  if (options.reloadOnChanges) startFilesystemWatcher(project);
  if (options.terminalCommands) startTerminalCommandListener(project);
  await startIPCServer(serverSocketPath, project);

  // kickoff the first child process
  options.supervise && log.info(`Supervision starting for command: node ${options.argv.join(" ")}`);
  await project.invalidateBuildSetAndReload();

  process.on("SIGINT", () => {
    log.debug(`process ${process.pid} got SIGINT`);
    span.end();

    void telemetry.shutdown().finally(() => project.shutdown(0))
  });
  process.on("SIGTERM", () => {
    log.debug(`process ${process.pid} got SIGTERM`);
    span.end();
    void telemetry.shutdown().finally(() => project.shutdown(0))
  });

  project.supervisor.process.on("exit", (code) => {
    log.debug(`child process exited with code ${code}, ${options.supervise ? "not exiting because supervise mode" : "exiting..."}`);
    span.end();
    if (!options.supervise) {
      void telemetry.shutdown().finally(() => project.shutdown(code ?? 1))
    }
  });
};
