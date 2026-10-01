# Teammate in-flight story (for the Collision Guard demo)

1. In Copado, create a user story titled "Route APAC accounts" in the same pipeline (note its name, e.g. US-0000456).
2. In your DEV org, open Developer Console → TerritoryAssigner and change 'EMEA' to 'APAC'. Save.
3. Commit ApexClass TerritoryAssigner to that story (Copado UI "Commit Changes", or `agentia cicd` commit command you verified).
4. Do NOT promote it. It stays "in progress" so Sunset detects the collision.
