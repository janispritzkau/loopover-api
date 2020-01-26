require("dotenv").config()

import * as express from "express"
import * as cors from "cors"
import fetch from "node-fetch"
import * as jwt from "jsonwebtoken"
import * as crypto from "crypto"
import { Storage } from "./storage"

const PORT = +process.env.PORT!

const userData = new Storage("data")
const app = express()

app.use(cors())

app.get("/token/discord", (req, res, next) => (async () => {
  let response = await fetch(`https://discordapp.com/api/oauth2/token?${new URLSearchParams({
    grant_type: "authorization_code",
    code: req.query.code,
    redirect_uri: req.query.redirect_uri
  })}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString("base64")}`
    }
  })
  if (!response.ok) throw new Error(response.statusText)
  const token = await response.json()

  response = await fetch("https://discordapp.com/api/users/@me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.access_token}`
    }
  })
  if (!response.ok) throw new Error(response.statusText)

  const user = await response.json()
  const sub = crypto.createHash("sha1").update("discord").update(user.id).digest("hex")

  res.json({
    displayName: `${user.username}#${user.discriminator}`,
    token: jwt.sign({ sub, iat: Date.now() }, process.env.JWT_SECRET!)
  })
})().catch(next))

app.get("/token/google", (req, res, next) => (async () => {
  let response = await fetch(`https://oauth2.googleapis.com/token?${new URLSearchParams({
    grant_type: "authorization_code",
    code: req.query.code,
    redirect_uri: req.query.redirect_uri
  })}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.GOOGLE_CLIENT_ID}:${process.env.GOOGLE_CLIENT_SECRET}`).toString("base64")}`
    }
  })
  if (!response.ok) throw new Error(response.statusText)
  const token = await response.json()

  response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${token.access_token}`
    }
  })
  if (!response.ok) throw new Error(response.statusText)

  const userinfo = await response.json()
  const sub = crypto.createHash("sha1").update("google").update(userinfo.sub).digest("hex")

  res.json({
    displayName: userinfo.name,
    token: jwt.sign({ sub, iat: Date.now() }, process.env.JWT_SECRET!)
  })
})().catch(next))

app.use((req, res, next) => {
  let match: RegExpMatchArray | null
  if (match = (req.headers.authorization || "").match(/^Bearer (.+)/)) {
    res.locals.token = jwt.verify(match[1], process.env.JWT_SECRET!)
    res.locals.userId = res.locals.token.sub
    next()
  } else {
    res.status(401).end()
  }
})

app.use(express.json({ limit: 1024 * 1024 }))

app.post("/sync", (req, res, next) => (async () => {
  const solveIds = new Set<number>(req.body)
  const data: any[] = (await userData.get(res.locals.userId)) || []
  const solves: any[] = []

  for (const solve of data) {
    if (solveIds.has(solve.startTime)) {
      solveIds.delete(solve.startTime)
    } else {
      solves.push(solve)
    }
  }

  res.json({ missing: [...solveIds], solves })
})().catch(next))

app.put("/sync", (req, res, next) => (async () => {
  const solves: any[] = req.body

  const data: any[] = (await userData.get(res.locals.userId)) || []
  data.push(...solves)
  userData.set(res.locals.userId, data)

  res.end()
})().catch(next))

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
