require("dotenv").config()
import * as asyncHandler from "express-async-handler"
import * as querystring from "querystring"
import { MongoClient } from "mongodb"
import * as express from "express"
import * as cors from "cors"
import * as crypto from "crypto"
import fetch from "node-fetch"

const PORT = +process.env.PORT!

async function main() {
  const app = express()
  app.use(cors())

  const mongoClient = await MongoClient.connect("mongodb://localhost:27017", {
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 1000
  })

  const db = mongoClient.db("loopover")

  const users = db.collection("users")
  const solves = db.collection("solves")
  const sessions = db.collection("sessions")

  await solves.dropIndexes()
  solves.createIndex({ event: 1 })
  solves.createIndex({ user: 1 })
  solves.createIndex({ startTime: 1 })

  sessions.createIndex({ token: 1 })

  app.post("/authenticate/google", asyncHandler(async (req, res) => {
    let response = await fetch(`https://oauth2.googleapis.com/token?${querystring.stringify({
      grant_type: "authorization_code",
      code: req.query.code!.toString(),
      redirect_uri: req.query.redirect_uri!.toString()
    })}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.GOOGLE_CLIENT_ID}:${process.env.GOOGLE_CLIENT_SECRET}`).toString("base64")}`
      }
    })

    if (!response.ok) throw new Error(response.statusText)
    const token = await response.json()

    response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })

    if (!response.ok) throw new Error(response.statusText)
    const userinfo = await response.json()

    const user = (await users.findOneAndUpdate({ provider: "google", uid: userinfo.sub }, {
      $set: {
        name: userinfo.name,
        provider: "google",
        uid: userinfo.sub,
        avatarUrl: userinfo.picture,
        access_token: token.access_token,
        ...token.refresh_token && { refresh_token: token.refresh_token }
      }
    }, { upsert: true, returnOriginal: false })).value

    const cookieToken = crypto.randomBytes(16).toString("base64")
    await sessions.insertOne({ token: cookieToken, user: user._id })

    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl,
      token: cookieToken
    })
  }))

  app.post("/authenticate/discord", asyncHandler(async (req, res) => {
    let response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `${querystring.stringify({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code: req.query.code!.toString(),
        redirect_uri: req.query.redirect_uri!.toString()
      })}`
    })

    if (!response.ok) throw new Error(response.statusText)
    const token = await response.json()

    response = await fetch("https://discordapp.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })

    if (!response.ok) throw new Error(response.statusText)
    const me = await response.json()

    const user = (await users.findOneAndUpdate({ provider: "discord", uid: me.id }, {
      $set: {
        name: `${me.username}#${me.discriminator}`,
        provider: "discord",
        uid: me.id,
        avatarUrl: me.avatar
          ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/${me.discriminator % 5}.png`,
        access_token: token.access_token,
        ...token.refresh_token && { refresh_token: token.refresh_token }
      }
    }, { upsert: true, returnOriginal: false })).value

    const cookieToken = crypto.randomBytes(16).toString("base64")
    await sessions.insertOne({ token: cookieToken, user: user._id })

    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl,
      token: cookieToken
    })
  }))

  app.get("/statistics/:event/:type", asyncHandler(async (req, res) => {
    const event = req.params.event

    const solvesPerUser: { solves: any[] }[] = await solves.aggregate([
      { $match: { event, dnf: { $ne: true } } },
      {
        $project: {
          time: 1,
          user: 1,
          moves: { $size: "$moves" }
        }
      },
      {
        $group: {
          _id: "$user",
          solves: { $push: "$$ROOT" }
        }
      },
    ]).toArray()

    let scores = solvesPerUser.reduce<{ score: number, weight: number }[]>((scores, { solves }) => {
      solves.forEach((solve: any) => {
        const score = req.params.type == "moves" ? solve.moves : solve.time / 1000

        const weight = 1 / (2 + solves.length)
        scores.push({ score, weight })
      })
      return scores
    }, [])

    if (scores.length < 2) return res.json({ labels: [], data: [] })

    scores.sort((a, b) => a.score - b.score)

    const lim = Math.ceil(scores.length / 28)
    if (scores.length > 28) scores = scores.slice(~~(lim * 0.7), -~~lim)

    const start = Math.floor(scores[0].score * 0.9)
    const end = Math.ceil(scores[scores.length - 1].score * 1.1)
    const step = Math.round(0.5 + (end - start) / 12)

    const labels = [...Array(Math.ceil((end - start + step) / step))].map((_, i) => start + i * step)

    const data = labels.map(() => 0)
    for (const { score, weight } of scores) {
      const x = Math.min(score / step - start / step, labels.length - 1)
      const v = x - ~~x
      data[~~x] += (1 - v) * weight
      data[~~x + Math.ceil(v)] += v * weight
    }

    const max = data.reduce((a, b) => Math.max(a, b), 0)
    res.json({ labels, data: data.map(x => x / max) })
  }))

  app.use((req, res, next) => {
    let match: RegExpMatchArray | null
    if (match = (req.headers.authorization || "").match(/^Bearer (.+)/)) {
      sessions.findOne({ token: match[1] }).then(session => {
        if (!session) return res.status(401).end()
        sessions.updateOne({ token: match![1] }, { $set: { lastUsed: Date.now() } })
        res.locals.token = session.token
        res.locals.uid = session.user
        next()
      }).catch(next)
    } else {
      res.status(401).end()
    }
  })

  app.get("/me", asyncHandler(async (_req, res) => {
    const user = await users.findOne({ _id: res.locals.uid })
    res.json({
      name: user.name,
      avatarUrl: user.avatarUrl
    })
  }))

  app.use(express.json({ limit: 1024 * 512 }))

  app.post("/sync", asyncHandler(async (req, res) => {
    const allSolves = await solves.find({ user: res.locals.uid }).toArray()

    const solveIds = new Set<number>(req.body)
    const sendSolves: any[] = []

    for (const solve of allSolves) {
      if (solveIds.has(solve.startTime)) {
        solveIds.delete(solve.startTime)
      } else {
        sendSolves.push({ ...solve, _id: undefined, user: undefined })
      }
    }

    if (req.headers["api-version"] == null) {
      sendSolves.forEach(solve => {
        solve.moves = deserializeMoves(solve.moves)
      })
    }

    res.json({ missing: [...solveIds], solves: sendSolves })
  }))

  app.put("/sync", asyncHandler(async (req, res) => {
    for (const solve of req.body) {
      if (solve._id != null) return res.status(400).end()
      if (typeof solve.startTime != "number") return res.status(400).end()
    }

    solves.insertMany(req.body.map(({ ...solve }: any) => {
      if (req.headers["api-version"] == null) solve.moves = serializeMoves(solve.moves)

      solve.user = res.locals.uid
      return solve
    }))
    res.end()
  }))

  app.delete("/sync", asyncHandler(async (req, res) => {
    if (!(req.body instanceof Array)) return res.status(400).end()
    await solves.deleteMany({ user: res.locals.uid, startTime: { $in: req.body } })
    res.end()
  }))

  app.listen(PORT)
}

function serializeMoves(moves: { axis: "row" | "col", index: number, n: number, time: number }[]) {
  let lastTime = 0
  return moves.map(move => {
    const time = move.time! - lastTime
    lastTime = move.time!
    return [+(move.axis == "col"), move.index, move.n, time]
  })
}

function deserializeMoves(moves: number[][]) {
  let lastTime = 0
  return moves.map(move => ({
    axis: move[0] ? "col" : "row", index: move[1], n: move[2],
    time: (lastTime += move[3])
  }))
}

main()
