import type { Context, DdcGatherItems } from "jsr:@shougo/ddc-vim@~9.5.0/types";
import { BaseSource } from "jsr:@shougo/ddc-vim@~9.5.0/source";

import type { Denops } from "jsr:@denops/core@~7.0.0";
import * as fn from "jsr:@denops/std@~7.6.0/function";
import * as op from "jsr:@denops/std@~7.6.0/option";
import * as vars from "jsr:@denops/std@~7.6.0/variable";

import { TextLineStream } from "jsr:@std/streams@~1.0.3/text-line-stream";
import { is } from "jsr:@core/unknownutil@~4.3.0/is";

const RE_RANGE =
  /(?:[0-9.$%, :]+|'.|\\[/?&]|\/(?:[^\\/]+|\\.)*\/|\?(?:[^\\?]+|\\.)*\?)*/;
const RE_SILENT = /(?:sil(?:e?|ent?)\b!?)?/;
const RE_TERMINAL = /(?:ter(?:m?|min?|minal?)\b!?(?:\s+\+\+\S*)*)/;
const RE_CMD_PREFIX = new RegExp(
  `^[:\\s]*${RE_SILENT.source}[:\\s]*${RE_RANGE.source}[:\\s]*(?:!|${RE_TERMINAL.source})`,
);
const RE_COMPLETE_TARGET = /\S*$/;

type Params = {
  envs: Record<string, string>;
  shell: string;
};

const isEnvs = is.RecordObjectOf(is.String);

export class Source extends BaseSource<Params> {
  #completer?: (cmdline: string) => Promise<string[]>;

  override async onInit(args: {
    denops: Denops;
    sourceParams: Params;
  }) {
    const { denops } = args;
    const { shell, envs } = args.sourceParams;

    if (!shell || !is.String(shell)) {
      await this.#printError(denops, `Invalid param: shell`);
      return;
    }
    if (!isEnvs(envs)) {
      await this.#printError(denops, `Invalid param: envs`);
      return;
    }

    const runtimepath = await op.runtimepath.getGlobal(denops);
    const [capture] = await denops.call(
      "globpath",
      runtimepath,
      `bin/ddc-source-shell_native/capture.${shell}`,
      1,
      1,
    ) as string[];

    if (!capture) {
      await this.#printError(denops, `Not supported shell: ${shell}`);
      return;
    }

    const command = new Deno.Command(
      shell,
      {
        args: [capture],
        stdout: "piped",
        stderr: "piped",
        stdin: "piped",
        cwd: await fn.getcwd(denops) as string,
        env: {
          // Merge environment variables.
          // This is necessary to ensure that the shell has access to the same
          // environment as Vim.
          ...await fn.environ(denops) as Record<string, string>,
          ...envs,
        },
      },
    );

    let proc: Deno.ChildProcess;
    try {
      proc = command.spawn();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        this.#printError(denops, `Command not found: ${shell}`);
      } else {
        this.#printError(denops, `Failed to spawn process: ${e}`);
      }
      return;
    }

    const outputBuffer: string[] = [];
    let eofWaiter: PromiseWithResolvers<string[]> | undefined;

    const stdout = proc.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .pipeTo(
        new WritableStream({
          write: (chunk: string) => {
            // Collect output lines
            outputBuffer.push(chunk);
          },
        }),
      );

    const stderr = proc.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .pipeTo(
        new WritableStream({
          write: (chunk: string) => {
            // Wait until "EOF"
            if (chunk === "EOF") {
              // Move out buffered output lines
              const output = outputBuffer.splice(0);
              eofWaiter?.resolve(output);
            } else {
              this.#printError(denops, `${shell}: ${chunk}`);
            }
          },
        }),
      );

    const { writable, readable } = new TextEncoderStream();
    readable.pipeTo(proc.stdin);
    const cmdlineWriter = writable.getWriter();

    this.#completer = async (cmdline: string): Promise<string[]> => {
      if (!this.#completer) {
        return [];
      }

      // Wait for the previous completion to finish
      await eofWaiter?.promise;

      const { promise } = eofWaiter = Promise.withResolvers();
      cmdlineWriter.write(cmdline + "\n");
      return await promise;
    };

    const dispose = () => {
      this.#completer = undefined;
      eofWaiter?.resolve([]);
      eofWaiter = undefined;
      try {
        proc.kill();
      } catch {
        // Prevent error if already stopped
      }
    };

    // Clean up resources after the process ends
    Promise.race([proc.status, stdout, stderr])
      .catch(() => {/* Prevent unhandled rejection */})
      .finally(async () => {
        if (this.#completer) {
          dispose();
          await this.#printError(denops, `Worker process terminated`);
        }
      });

    // Clean up resources when Denops is interrupted
    denops.interrupted?.addEventListener("abort", () => {
      dispose();
      this.isInitialized = false;
    });
  }

  override async getCompletePosition(args: {
    denops: Denops;
    context: Context;
  }): Promise<number> {
    const { input } = args.context;
    let completePos = input.search(RE_COMPLETE_TARGET);

    if (args.context.mode === "c") {
      // command-line mode
      const complType = await getCompletionType(args.denops, input);
      if (complType !== "shellcmd" && complType !== "shellcmdline") {
        return -1;
      }

      const prefixMatch = RE_CMD_PREFIX.exec(input);
      if (prefixMatch) {
        const prefixLength = prefixMatch[0].length;
        const cmdline = input.slice(prefixLength);
        const targetPos = cmdline.search(RE_COMPLETE_TARGET);
        if (targetPos >= 0) {
          completePos = prefixLength + targetPos;
        }
      }
    }

    return completePos;
  }

  override async gather(args: {
    denops: Denops;
    context: Context;
    completeStr: string;
    sourceParams: Params;
  }): Promise<DdcGatherItems> {
    const completer = this.#completer;
    if (!completer) {
      return [];
    }

    let { input } = args.context;

    if (args.context.mode === "c") {
      // command-line mode
      const prefixMatch = RE_CMD_PREFIX.exec(input);
      input = prefixMatch ? input.slice(prefixMatch[0].length) : "";
    } else {
      // NOT command-line mode
      const filetype = await op.filetype.getLocal(args.denops);
      const existsDeol = await fn.exists(args.denops, "*deol#get_input");
      if (filetype === "deol" && existsDeol) {
        input = await args.denops.call("deol#get_input") as string;
      }

      const uiName = await vars.b.get(args.denops, "ddt_ui_name", "");
      const existsDdt = await fn.exists(args.denops, "*ddt#get_input");
      if (uiName.length > 0 && existsDdt) {
        input = await args.denops.call("ddt#get_input", uiName) as string;
      }
    }

    input = input.trimStart();
    if (input.length === 0) {
      return [];
    }

    // Process collected lines
    const items = (await completer(input))
      .filter((line) => line.length > 0)
      .map((line) => {
        line = line.replace(/\/\/$/, "/"); // Replace the last //
        const [word, info] = line.split("\t", 2);
        return info ? { word, info } : { word };
      });

    return items;
  }

  override params(): Params {
    return {
      envs: {},
      shell: "",
    };
  }

  async #printError(denops: Denops, message: string): Promise<void> {
    await denops.call(
      "ddc#util#print_error",
      message,
      `ddc-source-${this.name}`,
    );
  }
}

async function getCompletionType(
  denops: Denops,
  input: string,
): Promise<string> {
  if (await fn.mode(denops) === "c") {
    const complType = await fn.getcmdcompltype(denops);
    if (complType === "shellcmd" || complType === "shellcmdline") {
      return complType;
    }
  }

  const prefixMatch = RE_CMD_PREFIX.exec(input);
  if (prefixMatch) {
    return "shellcmdline";
  }

  if (await fn.exists(denops, "*getcompletiontype")) {
    return await denops.call("getcompletiontype", input) as string;
  }

  return "";
}
