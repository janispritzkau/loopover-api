import * as util from "util"
import * as path from "path"
import * as fs from "fs"

export class Storage {
  constructor(public path: string) {
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path)
    }
  }

  async get(key: string) {
    try {
      return JSON.parse(await util.promisify(fs.readFile)(path.join(this.path, key + ".json"), "utf-8"))
    } catch {
      return undefined
    }
  }

  async set(key: string, value: any) {
    await util.promisify(fs.writeFile)(path.join(this.path, key + ".json"), JSON.stringify(value))
  }
}