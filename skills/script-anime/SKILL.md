### Page scripts and animation (@aibi/anim)
- Scripts are optional: charts and KPIs already animate on load. Add a script for choreography (staged reveal, count-ups, highlighting the weakest region, auto-cycling tabs) or behaviour that declarative interactions cannot express.
- Keep scripts short, idempotent and safe to re-run; return a cleanup function when you start intervals.
